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

    // `+`/`-` sign directly in front of a quoted phrase: capture it so
    // `-`"garlic bread"` tokenizes as one token instead of a bare `-`
    // followed by a positive phrase.
    let sign = ''
    if ((query[i] === '-' || query[i] === '+') && query[i + 1] === '"') {
      sign = query[i]!
      i++
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
        tokens.push(sign + '"' + phrase)
        return { tokens, balanced: false }
      }
      i++
      if (phrase.length > 0) tokens.push(sign + '"' + phrase + '"')
      continue
    }

    if (query[i] === '(' || query[i] === ')') {
      if (sign) tokens.push(sign)
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
 * A query that is ONLY negations subtracts from the whole catalog.
 */
export function parseSearchQuery(query: string): SearchAst {
  if (!query.trim()) return []

  const { tokens, balanced } = tokenize(query)
  if (tokens.length === 0) return []

  if (!balanced) {
    return tokens.map((t) => ({ type: 'term', term: literalTerm(t) }))
  }

  let pos = 0

  /**
   * One OR-separated clause sequence. `inGroup` stops the scan at `)`
   * (the group's own loop consumes it); at the top level a stray `)` is
   * an unexpected token the caller handles.
   */
  function parseOrClause(inGroup: boolean): SearchClause {
    const andClauses = [parseAndClause()]
    let hadExplicitAnd = false
    while (pos < tokens.length) {
      if (tokens[pos] === 'AND') {
        hadExplicitAnd = true
        pos++
        andClauses.push(parseAndClause())
      } else if (tokens[pos] === 'OR') {
        break
      } else if (tokens[pos] === ')' && inGroup) {
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
      // Inside parens the SAME grammar applies (ADR-0060: nested groups
      // with the same operators): explicit AND/OR are honored, adjacent
      // terms are implicit AND, and top-level ORs separate clauses. The
      // group's combine is OR only when the user actually typed OR.
      const inner: SearchClause[] = [parseOrClause(true)]
      while (pos < tokens.length && tokens[pos] !== ')') {
        if (tokens[pos] === 'OR') {
          pos++ // consume OR
          inner.push(parseOrClause(true))
        } else {
          break // defensive: parseOrClause consumed everything it could
        }
      }
      if (pos < tokens.length && tokens[pos] === ')') pos++ // consume ')'
      if (inner.length === 1) return inner[0]!
      return { type: 'group', combine: 'OR', explicit: true, clauses: inner }
    }

    if (tokens[pos] === ')') {
      // Encountered by inGroup=false only (the group loop consumes its
      // own); treat as a literal so the parser never throws.
      pos++
      return { type: 'term', term: literalTerm('') }
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

    // Sign modifiers come first (+term / -term), then quotes or wildcard
    // on what remains — so `-`"garlic bread"` is a negated exact phrase.
    if (text.startsWith('+')) {
      exact = true
      text = text.slice(1)
    } else if (text.startsWith('-') && text.length > 1) {
      negate = true
      exact = true
      text = text.slice(1)
    }
    if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
      exact = true
      text = text.slice(1, -1)
    } else if (!exact && text.endsWith('*') && text.length > 1) {
      prefix = true
      text = text.slice(0, -1)
    }

    // Negation is negation everywhere: a leading `-soup` subtracts soup
    // from the whole catalog rather than searching FOR soup.
    return { text, prefix, exact, negate }
  }

  const ast: SearchClause[] = [parseOrClause(false)]
  while (pos < tokens.length) {
    if (tokens[pos] === 'OR') {
      pos++
      ast.push(parseOrClause(false))
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
  // Punctuation is not a token boundary in prose but IS in MiniSearch's
  // tokenizer — match it, so "Tomato Soup, Basil" yields the token
  // "soup" and the phrase "tomato soup" stays adjacent.
  return termText
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

function docTokens(text: string): string[] {
  return phraseTokens(text)
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
  const ingredientTokens = docTokens(doc.ingredients)
  return containsConsecutive(ingredientTokens, phraseTokensArr)
}

function hasExplicitOperator(ast: SearchAst): boolean {
  // More than one top-level clause means there was a top-level OR (explicit)
  if (ast.length > 1) return true
  return clauseHasOperator(ast[0]!)
}

/**
 * Recurse over the whole clause tree: a phrase, `+term`, `term*` or `-term`
 * ANYWHERE (nested in an implicit-AND group, inside parens) means the user
 * typed an operator and the explicit evaluator must own the query — not the
 * fuzzy bare path, which would flatten it to plain terms.
 */
function clauseHasOperator(clause: SearchClause): boolean {
  if (clause.type === 'term') {
    return clause.term.exact || clause.term.prefix || clause.term.negate
  }
  if (clause.explicit) return true
  return clause.clauses.some(clauseHasOperator)
}

// ── Index ───────────────────────────────────────────────────────────────────

let index: MiniSearch<SearchDoc> | null = null
let indexPromise: Promise<MiniSearch<SearchDoc> | null> | null = null

export async function getSearchIndex(): Promise<MiniSearch<SearchDoc> | null> {
  if (index) return index
  if (!catalog.value) return null
  // Cache the IN-FLIGHT promise, not just the result: the suggest (150 ms)
  // and search (200 ms) watchers both call this before the first fetch
  // finishes, and without the promise guard each call downloads and parses
  // the whole index again.
  if (!indexPromise) {
    indexPromise = loadSearchIndex().then((loaded) => {
      index = loaded
      return loaded
    })
  }
  try {
    return await indexPromise
  } catch {
    // Reset so the next call can retry a failed load.
    indexPromise = null
    return null
  }
}

async function loadSearchIndex(): Promise<MiniSearch<SearchDoc>> {
  const c = catalog.value
  if (!c) throw new Error('catalog not loaded')
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}data/search_index.json`)
    if (!res.ok) throw new Error(`search index HTTP ${res.status}`)
    const json = await res.text()
    return MiniSearch.loadJSON<SearchDoc>(json, INDEX_OPTIONS)
  } catch {
    const fallback = new MiniSearch<SearchDoc>(INDEX_OPTIONS)
    fallback.addAll(
      c.variantMeta.map((meta) => ({
        id: meta.id,
        name: meta.name,
        ingredients: meta.ingredient_names.join(' '),
      })),
    )
    return fallback
  }
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

  // Docs (for phrase adjacency) are built LAZILY and memoized at MODULE
  // level: the catalog is frozen per session, so the memo survives across
  // calls — a per-call memo rebuilt ~2.8k docs on every phrase search.
  const getDocs = getDocsFactory()

  return searchWithIndex(idx, query, getDocs)
}

let docsCache: { for: unknown; docs: SearchDoc[] } | null = null

/** Memoized adjacency docs for the current catalog (module-level). */
function getDocsFactory(): () => SearchDoc[] {
  return () => {
    const c = catalog.value
    if (!docsCache || docsCache.for !== c) {
      docsCache = { for: c, docs: c ? c.variantMeta.map((meta) => buildSearchDoc(meta)) : [] }
    }
    return docsCache.docs
  }
}

/** Core search logic, testable with an arbitrary index and doc set. */
export async function searchWithIndex(
  idx: MiniSearch<SearchDoc>,
  query: string,
  docs: SearchDoc[] | (() => SearchDoc[]),
): Promise<SearchResults> {
  if (!query.trim()) return { primary: [], fallback: [] }

  const ast = parseSearchQuery(query)
  if (ast.length === 0) return { primary: [], fallback: [] }

  const getDocs = (): SearchDoc[] => (typeof docs === 'function' ? docs() : docs)

  if (hasExplicitOperator(ast)) {
    const ids = await evaluateExplicit(idx, ast, getDocs)
    return { primary: ids, fallback: [] }
  }

  // Bare query: AND primary + OR fallback
  // The primary is a LITERAL AND (prefix ok, fuzzy OFF): with fuzzy 0.2 a
  // 4-letter term tolerates 1 edit, so "pork" matched "york" ("New York
  // strip") and beef recipes surfaced for "rice pork". Forgiveness lives
  // in the OR fallback below the divider, where it cannot masquerade as
  // an all-words match.
  const primary = await searchCombine(idx, ast, 'AND', getDocs, true)
  if (primary.length < DISPLAY_WINDOW) {
    const orIds = await searchCombine(idx, ast, 'OR', getDocs, false)
    const fallback = orIds.filter((id) => !primary.includes(id))
    return { primary, fallback }
  }

  return { primary, fallback: [] }
}

// ── Explicit query evaluation ────────────────────────────────────────────────

async function evaluateExplicit(
  idx: MiniSearch<SearchDoc>,
  ast: SearchAst,
  getDocs: () => SearchDoc[],
): Promise<number[]> {
  // The top level is a UNION of OR branches; each branch computes its own
  // set, and a negated branch means "everything except X" — NOT a global
  // subtraction (soup OR -bread must keep soup recipes containing bread:
  // the soup branch alone satisfies the query for them).
  const branches: number[][] = []

  for (const clause of ast) {
    if (clause.type === 'group') {
      branches.push(await evaluateGroup(idx, clause, getDocs))
    } else if (clause.term.negate) {
      // Standalone negated OR branch: catalog minus the negated matches.
      const hits = new Set(await searchTermIds(idx, clause.term, getDocs))
      branches.push(getDocs().map((d) => d.id).filter((id) => !hits.has(id)))
    } else {
      branches.push(await searchTermIds(idx, clause.term, getDocs))
    }
  }

  const result = new Set<number>()
  for (const ids of branches) {
    for (const id of ids) result.add(id)
  }
  return [...result]
}

async function evaluateGroup(
  idx: MiniSearch<SearchDoc>,
  group: { type: 'group'; combine: 'AND' | 'OR'; explicit: boolean; clauses: SearchClause[] },
  getDocs: () => SearchDoc[],
): Promise<number[]> {
  const positiveSets: number[][] = []
  const negativeSets: Set<number>[] = []
  const negativeIds: number[] = []

  for (const clause of group.clauses) {
    if (clause.type === 'term' && clause.term.negate) {
      const hits = await searchTermIds(idx, clause.term, getDocs)
      // Per-negation sets (for the OR complement); negativeIds is the
      // flattened union (for the AND complement and the subtraction).
      negativeSets.push(new Set(hits))
      negativeIds.push(...hits)
    } else if (clause.type === 'term') {
      positiveSets.push(await searchTermIds(idx, clause.term, getDocs))
    } else if (clause.type === 'group') {
      positiveSets.push(await evaluateGroup(idx, clause, getDocs))
    }
  }

  if (positiveSets.length === 0) {
    // A positive-LESS group (-soup -bread, or a nested (-cream) inside an
    // AND) is still meaningful: it contributes a complement. The combinator
    // matters (De Morgan): AND(-a -b) = complement(a ∪ b), while
    // OR(-a -b) = complement(a ∩ b) — a doc is kept when AT LEAST ONE
    // negation misses it. Returning the AND complement for an OR group
    // over-excluded (soup (-onion OR -garlic) dropped an onion-only soup).
    const docIds = getDocs().map((d) => d.id)
    if (group.combine === 'OR') {
      // Reuse the per-negation sets collected in the main loop — no
      // re-search. A doc is kept when at least one negation misses it.
      return docIds.filter((id) => negativeSets.some((set) => !set.has(id)))
    }
    const hits = new Set(negativeIds)
    return docIds.filter((id) => !hits.has(id))
  }

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
    // OR: a negated member is its own complement BRANCH — soup OR -bread
    // inside parens must mean soup ∪ (everything but bread), matching the
    // top-level per-branch semantics. (Subtraction is AND-group behavior.)
    const result = new Set<number>()
    for (const set of positiveSets) {
      for (const id of set) result.add(id)
    }
    const docIds = getDocs().map((d) => d.id)
    for (const nset of negativeSets) {
      for (const id of docIds) {
        if (!nset.has(id)) result.add(id)
      }
    }
    return [...result]
  }
}

/** Search for a single term, returning matching doc ids. */
async function searchTermIds(
  idx: MiniSearch<SearchDoc>,
  term: SearchTerm,
  getDocs: () => SearchDoc[],
): Promise<number[]> {
  const text = term.text
  if (!text) return []

  const options: SearchOptions = {
    fields: SEARCH_FIELDS,
    boost: { name: 2 },
  }

  // Exact (+term, "phrase") and NEGATED terms are literal per the ADR:
  // `-pea` must never sweep away "peanut", "pear" or "peach" through
  // prefix/fuzzy backdoors.
  if (term.exact || term.negate) {
    options.prefix = false
    options.fuzzy = false
  } else if (term.prefix) {
    options.prefix = true
    options.fuzzy = false
  } else {
    options.prefix = true
    options.fuzzy = 0.2
  }

  // For exact multi-term phrases (quoted — including negated ones), AND
  // the individual tokens
  let ids: number[]
  if ((term.exact || term.negate) && !term.prefix) {
    const tokens = phraseTokens(text)
    if (tokens.length === 0) return []
    if (tokens.length === 1) {
      ids = idx.search(tokens[0]!, options).map((r) => r.id as number)
    } else {
      ids = idx
        .search(tokens.join(' '), { ...options, combineWith: 'AND' })
        .map((r) => r.id as number)
    }
  } else {
    ids = idx.search(text, options).map((r) => r.id as number)
  }

  // Phrase adjacency is checked PER TERM, here: every clause — top-level
  // or nested in a group — filters its OWN matches, so `("garlic bread"
  // AND soup)` requires the consecutive phrase, and `"garlic bread" OR
  // soup` lets plain soup matches through.
  const tokens = phraseTokens(text)
  if (term.exact && !term.prefix && tokens.length > 1) {
    const docArr = getDocs()
    const docMap = new Map(docArr.map((d) => [d.id, d]))
    ids = ids.filter((id) => {
      const doc = docMap.get(id)
      return doc !== undefined && isPhraseAdjacent(doc, tokens)
    })
  }

  return ids
}

// ── Bare query evaluation ────────────────────────────────────────────────────

async function searchCombine<T>(
  idx: MiniSearch<T>,
  ast: SearchAst,
  combine: 'AND' | 'OR',
  _getDocs: () => SearchDoc[],
  exactTerms = false,
): Promise<number[]> {
  const positiveTexts: string[] = []
  const negativeTexts: string[] = []

  // Flatten recursively: a bare query can still CONTAIN groups (implicit
  // AND of plain terms), and nested ones must not be dropped.
  function collect(clause: SearchClause): void {
    if (clause.type === 'term') {
      if (clause.term.negate) negativeTexts.push(clause.term.text)
      else positiveTexts.push(clause.term.text)
    } else {
      for (const sub of clause.clauses) collect(sub)
    }
  }
  for (const clause of ast) collect(clause)

  if (positiveTexts.length === 0) return []

  const query = positiveTexts.join(' ')
  const allResults = idx.search(query, {
    fields: SEARCH_FIELDS,
    combineWith: combine,
    prefix: true,
    // exactTerms (the AND-primary pass) keeps word identity: fuzzy 0.2 on
    // a 4-letter term tolerates 1 edit and "pork" matched "york".
    fuzzy: exactTerms ? false : 0.2,
    boost: { name: 2 },
  })
  const results = allResults.map((r) => r.id as number)

  if (negativeTexts.length > 0) {
    // Negated terms are literal (no prefix, no fuzzy) — `-pea` must not
    // remove "peanut" or "pear".
    const negResults = idx
      .search(negativeTexts.join(' '), {
        fields: SEARCH_FIELDS,
        prefix: false,
        fuzzy: false,
        combineWith: 'OR',
      })
      .map((r) => r.id as number)
    const negSet = new Set(negResults)
    return results.filter((id) => !negSet.has(id))
  }

  return results
}
