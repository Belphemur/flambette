import MiniSearch, { type Options, type SearchOptions } from 'minisearch'
import type { VariantMeta } from './types'
import { catalog } from './catalog'

// ── Document shape ───────────────────────────────────────────────────────────

/** Document shape indexed by MiniSearch. */
export interface SearchDoc {
  /** Variant id — also used as the MiniSearch document id. */
  id: number
  name: string
  /** Space-joined ingredient names (tokenized by MiniSearch). */
  ingredients: string
}

/** Build a SearchDoc from a VariantMeta (single source of truth). */
export function buildSearchDoc(meta: VariantMeta): SearchDoc {
  return {
    id: meta.id,
    name: meta.name,
    ingredients: meta.ingredient_names.join(' '),
  }
}

// ── Query AST ──────────────────────────────────────────────────────────────

/** The parsed query: a flat list of top-level OR-clauses. */
export type SearchAst = SearchClause[]

export type SearchClause =
  | { type: 'term'; term: SearchTerm }
  | { type: 'group'; combine: 'AND' | 'OR'; explicit: boolean; clauses: SearchClause[] }

export type SearchTerm = {
  /** The raw text, stripped of +, -, * and surrounding quotes. */
  text: string
  /** True if the term had a trailing `*` → prefix-only match. */
  prefix: boolean
  /** True if the term was quoted, `+`-prefixed, or `-`-prefixed → exact match. */
  exact: boolean
  /** True if the term was `-`-prefixed → must NOT match (excluded from results). */
  negate: boolean
}

// ── Search results ──────────────────────────────────────────────────────────

export interface SearchResults {
  /** Primary results: documents matching every term (AND). */
  primary: number[]
  /** Fallback results: OR matches not in primary, shown under "More results". */
  fallback: number[]
}

// ── Index options ────────────────────────────────────────────────────────────

export const SEARCH_FIELDS = ['name', 'ingredients']

export const INDEX_OPTIONS: Options<SearchDoc> = {
  fields: SEARCH_FIELDS,
  idField: 'id',
  searchOptions: {
    prefix: true,
    fuzzy: 0.2,
    boost: { name: 2 },
  },
}

// ── Tokenizer ───────────────────────────────────────────────────────────────

function tokenize(query: string): { tokens: string[]; balanced: boolean } {
  const tokens: string[] = []
  let i = 0
  const n = query.length

  while (i < n) {
    if (/\s/.test(query[i]!)) {
      i++
      continue
    }

    // Double-quoted phrase
    if (query[i] === '"') {
      i++
      let phrase = ''
      while (i < n && query[i] !== '"') {
        phrase += query[i]!
        i++
      }
      if (i >= n) {
        tokens.push('"' + phrase)
        return { tokens, balanced: false }
      }
      i++
      if (phrase.length > 0) tokens.push('"' + phrase + '"')
      continue
    }

    if (query[i] === '(' || query[i] === ')') {
      tokens.push(query[i]!)
      i++
      continue
    }

    let token = ''
    while (
      i < n &&
      !/\s/.test(query[i]!) &&
      query[i]! !== '(' &&
      query[i]! !== ')' &&
      query[i]! !== '"'
    ) {
      token += query[i]!
      i++
    }
    if (token) tokens.push(token)
  }

  let depth = 0
  for (const t of tokens) {
    if (t === '(') depth++
    if (t === ')') depth--
    if (depth < 0) return { tokens, balanced: false }
  }
  if (depth !== 0) return { tokens, balanced: false }

  return { tokens, balanced: true }
}

// ── Parser ──────────────────────────────────────────────────────────────────

/**
 * Parse a query string into a SearchAst.
 *
 * Grammar:
 *   query      := or_clause (OR or_clause)*
 *   or_clause  := and_clause (AND and_clause)*
 *   and_clause := '(' query ')' | term
 *   term       := '"phrase"' | '+' term | '-' term | term '*' | term
 *
 * Unbalanced quotes/parens degrade to literal terms (never throws).
 * `-term` at the very start of the query behaves as an ordinary term.
 */
export function parseSearchQuery(query: string): SearchAst {
  if (!query.trim()) return []

  const { tokens, balanced } = tokenize(query)
  if (tokens.length === 0) return []

  if (!balanced) {
    return tokens.map((t) => ({ type: 'term', term: literalTerm(t) }))
  }

  let pos = 0
  const firstToken = tokens[0]!

  function parseOrClause(): SearchClause {
    const andClauses = [parseAndClause()]
    let hadExplicitAnd = false
    while (pos < tokens.length) {
      if (tokens[pos] === 'AND') {
        hadExplicitAnd = true
        pos++
        andClauses.push(parseAndClause())
      } else if (tokens[pos] === 'OR') {
        break
      } else {
        // Implicit AND between adjacent terms (no explicit operator)
        andClauses.push(parseAndClause())
      }
    }
    if (andClauses.length === 1) return andClauses[0]!
    return { type: 'group', combine: 'AND', explicit: hadExplicitAnd, clauses: andClauses }
  }

  function parseAndClause(): SearchClause {
    if (pos >= tokens.length) {
      return { type: 'term', term: literalTerm('') }
    }

    if (tokens[pos] === '(') {
      pos++ // consume '('
      // Parse inner clauses with a ')' stop condition. Inside parens, clauses
      // are OR'd by default (lentil OR soup) — this is the standard behavior.
      const inner: SearchClause[] = [parseInnerAnd()]
      while (pos < tokens.length && tokens[pos] !== ')') {
        if (tokens[pos] === 'OR') {
          pos++ // consume OR
          inner.push(parseInnerAnd())
        } else {
          // Implicit AND or explicit AND inside parens
          inner.push(parseInnerAnd())
        }
      }
      if (pos < tokens.length && tokens[pos] === ')') pos++ // consume ')'
      if (inner.length === 1) return inner[0]!
      return { type: 'group', combine: 'OR', explicit: true, clauses: inner }
    }

    return { type: 'term', term: parseTerm() }
  }

  /** Parse a clause inside parentheses (handles nested parens via parseAndClause). */
  function parseInnerAnd(): SearchClause {
    if (pos >= tokens.length) {
      return { type: 'term', term: literalTerm('') }
    }
    if (tokens[pos] === '(') {
      return parseAndClause()
    }
    return { type: 'term', term: parseTerm() }
  }

  function parseTerm(): SearchTerm {
    if (pos >= tokens.length) {
      return literalTerm('')
    }
    const raw = tokens[pos]!
    pos++

    let text = raw
    let prefix = false
    let exact = false
    let negate = false

    if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
      text = raw.slice(1, -1)
      exact = true
    } else if (raw.startsWith('+')) {
      text = raw.slice(1)
      exact = true
    } else if (raw.startsWith('-')) {
      text = raw.slice(1)
      negate = true
      exact = true
    } else if (raw.endsWith('*') && raw.length > 1) {
      text = raw.slice(0, -1)
      prefix = true
    }

    // `-term` at the very start → ordinary term (nothing to subtract from)
    if (negate && raw === firstToken) {
      negate = false
      exact = false
    }

    return { text, prefix, exact, negate }
  }

  const ast: SearchClause[] = [parseOrClause()]
  while (pos < tokens.length) {
    if (tokens[pos] === 'OR') {
      pos++
      ast.push(parseOrClause())
    } else {
      // Unexpected token — treat as a literal term
      ast.push({ type: 'term', term: literalTerm(tokens[pos]!) })
      pos++
    }
  }

  return ast
}

function literalTerm(text: string): SearchTerm {
  return { text, prefix: false, exact: false, negate: false }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function phraseTokens(termText: string): string[] {
  return termText.toLowerCase().split(/\s+/).filter(Boolean)
}

function docTokens(text: string): string[] {
  return text.toLowerCase().split(/\s+/).filter(Boolean)
}

function containsConsecutive(haystack: string[], needles: string[]): boolean {
  if (needles.length > haystack.length) return false
  for (let i = 0; i <= haystack.length - needles.length; i++) {
    let match = true
    for (let j = 0; j < needles.length; j++) {
      if (haystack[i + j] !== needles[j]) {
        match = false
        break
      }
    }
    if (match) return true
  }
  return false
}

/** Check if all phrase tokens appear consecutively in name or ingredients. */
function isPhraseAdjacent(doc: SearchDoc, phraseTokensArr: string[]): boolean {
  if (phraseTokensArr.length <= 1) return true
  const nameTokens = docTokens(doc.name)
  if (containsConsecutive(nameTokens, phraseTokensArr)) return true
  const ingredientTokens = doc.ingredients.toLowerCase().split(/\s+/).filter(Boolean)
  return containsConsecutive(ingredientTokens, phraseTokensArr)
}

function hasExplicitOperator(ast: SearchAst): boolean {
  // More than one top-level clause means there was a top-level OR (explicit)
  if (ast.length > 1) return true
  // Single top-level clause
  const clause = ast[0]!
  if (clause.type === 'group') {
    // explicit=true → typed AND/OR; explicit=false → implicit AND (bare terms)
    return clause.explicit
  }
  if (clause.type === 'term') {
    if (clause.term.exact || clause.term.prefix || clause.term.negate) return true
  }
  return false
}

// ── Index ───────────────────────────────────────────────────────────────────

let index: MiniSearch<SearchDoc> | null = null

export async function getSearchIndex(): Promise<MiniSearch<SearchDoc> | null> {
  if (index) return index
  const c = catalog.value
  if (!c) return null

  try {
    const res = await fetch(`${import.meta.env.BASE_URL}data/search_index.json`)
    if (!res.ok) throw new Error(`search index HTTP ${res.status}`)
    const json = await res.text()
    index = MiniSearch.loadJSON<SearchDoc>(json, INDEX_OPTIONS)
  } catch {
    index = new MiniSearch<SearchDoc>(INDEX_OPTIONS)
    index.addAll(
      c.variantMeta.map((meta) => ({
        id: meta.id,
        name: meta.name,
        ingredients: meta.ingredient_names.join(' '),
      })),
    )
  }

  // Add user-recipe docs (not in the pre-built index, by design ADR-0052)
  const userMetas = c.variantMeta.filter((m) => c.userRecipeIds.has(m.id))
  if (userMetas.length > 0 && index) {
    index.addAll(
      userMetas.map((meta) => ({
        id: meta.id,
        name: meta.name,
        ingredients: meta.ingredient_names.join(' '),
      })),
    )
  }

  return index
}

// ── Suggest (autoSuggest) ────────────────────────────────────────────────────

export async function suggest(query: string, limit = 8): Promise<string[]> {
  const idx = await getSearchIndex()
  if (!idx) return []
  if (!query.trim()) return []
  const results = idx.autoSuggest(query.trim(), {
    fields: ['name'],
    combineWith: 'AND',
    boost: { name: 2 },
    prefix: true,
  })
  return results.slice(0, limit).map((r) => r.suggestion)
}

// ── Search (variant ids) ─────────────────────────────────────────────────────

const DISPLAY_WINDOW = 200

/**
 * Variant ids matching the query.
 *
 * For bare queries (no explicit operators): primary results are AND matches
 * (every term), with OR-fallback results appended when the AND set is smaller
 * than the display window. Explicit operators override these defaults.
 */
export async function searchVariantIds(query: string): Promise<SearchResults> {
  const idx = await getSearchIndex()
  if (!idx) return { primary: [], fallback: [] }
  if (!query.trim()) return { primary: [], fallback: [] }

  // Collect docs for adjacency checking
  const c = catalog.value
  const docs = c
    ? c.variantMeta.map((meta) => buildSearchDoc(meta))
    : []

  return searchWithIndex(idx, query, docs)
}

/** Core search logic, testable with an arbitrary index and doc set. */
export async function searchWithIndex(
  idx: MiniSearch<SearchDoc>,
  query: string,
  docs: SearchDoc[],
): Promise<SearchResults> {
  if (!query.trim()) return { primary: [], fallback: [] }

  const ast = parseSearchQuery(query)
  if (ast.length === 0) return { primary: [], fallback: [] }

  if (hasExplicitOperator(ast)) {
    const ids = await evaluateExplicit(idx, ast, docs)
    return { primary: ids, fallback: [] }
  }

  // Bare query: AND primary + OR fallback
  const primary = await searchCombine(idx, ast, 'AND', docs)
  if (primary.length < DISPLAY_WINDOW) {
    const orIds = await searchCombine(idx, ast, 'OR', docs)
    const fallback = orIds.filter((id) => !primary.includes(id))
    return { primary, fallback }
  }

  return { primary, fallback: [] }
}

// ── Explicit query evaluation ────────────────────────────────────────────────

async function evaluateExplicit(
  idx: MiniSearch<SearchDoc>,
  ast: SearchAst,
  docs: SearchDoc[],
): Promise<number[]> {
  const phraseTexts: string[][] = []
  const allIds = new Set<number>()

  for (const clause of ast) {
    if (clause.type === 'group') {
      const ids = await evaluateGroup(idx, clause, docs)
      for (const id of ids) allIds.add(id)
    } else if (clause.type === 'term') {
      if (clause.term.negate) {
        // -term as a standalone top-level clause → nothing to subtract from
        continue
      }
      const ids = await searchTermIds(idx, clause.term)
      for (const id of ids) allIds.add(id)
      if (clause.term.exact && !clause.term.prefix) {
        const tokens = phraseTokens(clause.term.text)
        if (tokens.length > 1) phraseTexts.push(tokens)
      }
    }
  }

  let result = [...allIds]

  // Apply phrase adjacency filter
  if (phraseTexts.length > 0) {
    const docMap = new Map(docs.map((d) => [d.id, d]))
    result = result.filter((id) => {
      const doc = docMap.get(id)
      if (!doc) return false
      for (const phrase of phraseTexts) {
        if (!isPhraseAdjacent(doc, phrase)) return false
      }
      return true
    })
  }

  return result
}

async function evaluateGroup(
  idx: MiniSearch<SearchDoc>,
  group: { type: 'group'; combine: 'AND' | 'OR'; explicit: boolean; clauses: SearchClause[] },
  docs: SearchDoc[],
): Promise<number[]> {
  const positiveSets: number[][] = []
  let negativeIds: number[] = []

  for (const clause of group.clauses) {
    if (clause.type === 'term' && clause.term.negate) {
      negativeIds.push(...(await searchTermIds(idx, clause.term)))
    } else if (clause.type === 'term') {
      positiveSets.push(await searchTermIds(idx, clause.term))
    } else if (clause.type === 'group') {
      positiveSets.push(await evaluateGroup(idx, clause, docs))
    }
  }

  if (positiveSets.length === 0) return []

  if (group.combine === 'AND') {
    // Intersect all positive sets
    let andResult = new Set(positiveSets[0]!)
    for (let i = 1; i < positiveSets.length; i++) {
      const next = new Set(positiveSets[i]!)
      const intersection = new Set<number>()
      for (const id of andResult) {
        if (next.has(id)) intersection.add(id)
      }
      andResult = intersection
    }
    // Subtract negative
    const negSet = new Set(negativeIds)
    return [...andResult].filter((id) => !negSet.has(id))
  } else {
    // OR between positive sets, then subtract negative globally
    const orResult = new Set<number>()
    for (const set of positiveSets) {
      for (const id of set) orResult.add(id)
    }
    const negSet = new Set(negativeIds)
    return [...orResult].filter((id) => !negSet.has(id))
  }
}

/** Search for a single term, returning matching doc ids. */
async function searchTermIds(
  idx: MiniSearch<SearchDoc>,
  term: SearchTerm,
): Promise<number[]> {
  const text = term.text
  if (!text) return []

  const options: SearchOptions = {
    fields: SEARCH_FIELDS,
    boost: { name: 2 },
  }

  if (term.exact && !term.negate) {
    options.prefix = false
    options.fuzzy = false
  } else if (term.prefix) {
    options.prefix = true
    options.fuzzy = false
  } else {
    options.prefix = true
    options.fuzzy = 0.2
  }

  // For exact multi-term phrases (quoted), AND the individual tokens
  if (term.exact && !term.prefix && !term.negate) {
    const tokens = phraseTokens(text)
    if (tokens.length === 0) return []
    if (tokens.length === 1) {
      return idx.search(tokens[0]!, options).map((r) => r.id as number)
    }
    return idx
      .search(tokens.join(' '), { ...options, combineWith: 'AND' })
      .map((r) => r.id as number)
  }

  return idx.search(text, options).map((r) => r.id as number)
}

// ── Bare query evaluation ────────────────────────────────────────────────────

async function searchCombine<T>(
  idx: MiniSearch<T>,
  ast: SearchAst,
  combine: 'AND' | 'OR',
  _docs: SearchDoc[],
): Promise<number[]> {
  const positiveTexts: string[] = []
  const negativeTexts: string[] = []

  for (const clause of ast) {
    if (clause.type === 'term') {
      if (clause.term.negate) {
        negativeTexts.push(clause.term.text)
      } else {
        positiveTexts.push(clause.term.text)
      }
    } else if (clause.type === 'group') {
      for (const sub of clause.clauses) {
        if (sub.type === 'term') {
          if (sub.term.negate) {
            negativeTexts.push(sub.term.text)
          } else {
            positiveTexts.push(sub.term.text)
          }
        }
      }
    }
  }

  if (positiveTexts.length === 0) return []

  const query = positiveTexts.join(' ')
  const allResults = idx.search(query, {
    fields: SEARCH_FIELDS,
    combineWith: combine,
    prefix: true,
    fuzzy: 0.2,
    boost: { name: 2 },
  })
  const results = allResults.map((r) => r.id as number)

  if (negativeTexts.length > 0) {
    const negResults = idx
      .search(negativeTexts.join(' '), {
        fields: SEARCH_FIELDS,
        prefix: true,
        fuzzy: 0.2,
      })
      .map((r) => r.id as number)
    const negSet = new Set(negResults)
    return results.filter((id) => !negSet.has(id))
  }

  return results
}
