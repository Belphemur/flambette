import { describe, expect, test } from 'bun:test'
import MiniSearch from 'minisearch'
import { parseSearchQuery, searchWithIndex, suggest, buildSearchDoc, INDEX_OPTIONS, type SearchAst, type SearchClause, type SearchTerm, type SearchResults, type SearchDoc } from './search'
import type { VariantMeta } from './types'

// ── Parser tests ────────────────────────────────────────────────────────────

describe('parseSearchQuery', () => {
  test('empty query returns empty AST', () => {
    expect(parseSearchQuery('')).toEqual([])
    expect(parseSearchQuery('   ')).toEqual([])
  })

  test('single bare term → one term clause', () => {
    const ast = parseSearchQuery('lentil')
    expect(ast).toHaveLength(1)
    expect(ast[0]!.type).toBe('term')
    expect((ast[0]! as SearchClause & { term: SearchTerm }).term.text).toBe('lentil')
    expect((ast[0]! as SearchClause & { term: SearchTerm }).term.prefix).toBe(false)
    expect((ast[0]! as SearchClause & { term: SearchTerm }).term.exact).toBe(false)
    expect((ast[0]! as SearchClause & { term: SearchTerm }).term.negate).toBe(false)
  })

  test('two bare terms → one AND group (implicit AND)', () => {
    const ast = parseSearchQuery('lentil soup')
    expect(ast).toHaveLength(1)
    const g = ast[0]! as SearchClause & { type: 'group'; combine: 'AND' | 'OR'; clauses: SearchClause[] }
    expect(g.type).toBe('group')
    expect(g.combine).toBe('AND')
    expect(g.clauses).toHaveLength(2)
    expect((g.clauses[0]! as SearchClause & { term: SearchTerm }).term.text).toBe('lentil')
    expect((g.clauses[1]! as SearchClause & { term: SearchTerm }).term.text).toBe('soup')
  })

  test('AND operator creates an AND group', () => {
    const ast = parseSearchQuery('lentil AND soup')
    expect(ast).toHaveLength(1)
    const g = ast[0]! as SearchClause & { type: 'group'; combine: 'AND' | 'OR'; clauses: SearchClause[] }
    expect(g.type).toBe('group')
    expect(g.combine).toBe('AND')
    expect(g.clauses).toHaveLength(2)
    expect((g.clauses[0]! as SearchClause & { term: SearchTerm }).term.text).toBe('lentil')
    expect((g.clauses[1]! as SearchClause & { term: SearchTerm }).term.text).toBe('soup')
  })

  test('OR operator creates two top-level clauses', () => {
    const ast = parseSearchQuery('lentil OR soup')
    expect(ast).toHaveLength(2)
    expect((ast[0]! as SearchClause & { term: SearchTerm }).term.text).toBe('lentil')
    expect((ast[1]! as SearchClause & { term: SearchTerm }).term.text).toBe('soup')
  })

  test('lowercase and/or are ordinary terms (implicit AND)', () => {
    const ast = parseSearchQuery('lentil and soup')
    expect(ast).toHaveLength(1)
    const g = ast[0]! as SearchClause & { type: 'group'; combine: 'AND' | 'OR'; clauses: SearchClause[] }
    expect(g.type).toBe('group')
    expect(g.combine).toBe('AND')
    expect(g.clauses).toHaveLength(3)
    const texts = g.clauses.map((c) => (c as SearchClause & { term: SearchTerm }).term.text)
    expect(texts).toContain('lentil')
    expect(texts).toContain('and')
    expect(texts).toContain('soup')
  })

  test('case-sensitivity: AND is uppercase only', () => {
    // uppercase AND → explicit AND operator → one group with 2 clauses
    const astUpper = parseSearchQuery('lentil AND soup')
    const gUpper = astUpper[0]! as SearchClause & { type: 'group'; combine: 'AND' | 'OR'; clauses: SearchClause[] }
    expect(gUpper.combine).toBe('AND')
    expect(gUpper.clauses).toHaveLength(2)
    // lowercase and → ordinary term → one group with 3 clauses
    const astLower = parseSearchQuery('lentil and soup')
    const gLower = astLower[0]! as SearchClause & { type: 'group'; combine: 'AND' | 'OR'; clauses: SearchClause[] }
    expect(gLower.combine).toBe('AND')
    expect(gLower.clauses).toHaveLength(3)
  })

  test('quoted phrase → exact term with phrase text', () => {
    const ast = parseSearchQuery('"garlic bread"')
    expect(ast).toHaveLength(1)
    const t = (ast[0]! as SearchClause & { term: SearchTerm }).term
    expect(t.text).toBe('garlic bread')
    expect(t.exact).toBe(true)
    expect(t.prefix).toBe(false)
    expect(t.negate).toBe(false)
  })

  test('+term → exact match', () => {
    const ast = parseSearchQuery('+garlic')
    const t = (ast[0]! as SearchClause & { term: SearchTerm }).term
    expect(t.text).toBe('garlic')
    expect(t.exact).toBe(true)
    expect(t.negate).toBe(false)
  })

  test('-term → negate (not at start)', () => {
    const ast = parseSearchQuery('soup -lentil')
    const g = ast[0]! as SearchClause & { type: 'group'; combine: 'AND' | 'OR'; clauses: SearchClause[] }
    const neg = g.clauses[1]! as SearchClause & { term: SearchTerm }
    expect(neg.term.text).toBe('lentil')
    expect(neg.term.negate).toBe(true)
    expect(neg.term.exact).toBe(true)
  })

  test('-term at very start → ordinary term', () => {
    const ast = parseSearchQuery('-lentil')
    const t = (ast[0]! as SearchClause & { term: SearchTerm }).term
    expect(t.text).toBe('lentil')
    expect(t.negate).toBe(false)
    expect(t.exact).toBe(false)
  })

  test('-term not at start → negate', () => {
    const ast = parseSearchQuery('soup -lentil')
    const g = ast[0]! as SearchClause & { type: 'group'; combine: 'AND' | 'OR'; clauses: SearchClause[] }
    // "soup" is the first term → ordinary; "-lentil" is not → negate
    expect((g.clauses[0]! as SearchClause & { term: SearchTerm }).term.negate).toBe(false)
    expect((g.clauses[1]! as SearchClause & { term: SearchTerm }).term.negate).toBe(true)
  })

  test('term* → prefix match', () => {
    const ast = parseSearchQuery('lent*')
    const t = (ast[0]! as SearchClause & { term: SearchTerm }).term
    expect(t.text).toBe('lent')
    expect(t.prefix).toBe(true)
    expect(t.exact).toBe(false)
  })

  test('nested parentheses → nested group', () => {
    const ast = parseSearchQuery('(lentil OR soup) AND bread')
    expect(ast).toHaveLength(1)
    const g = ast[0]! as SearchClause & { type: 'group'; combine: 'AND' | 'OR'; clauses: SearchClause[] }
    expect(g.type).toBe('group')
    expect(g.combine).toBe('AND')
    expect(g.clauses).toHaveLength(2)
    // First clause is the OR group
    const inner = g.clauses[0]! as SearchClause & { type: 'group'; combine: 'AND' | 'OR'; clauses: SearchClause[] }
    expect(inner.type).toBe('group')
    expect(inner.combine).toBe('OR')
    expect(inner.clauses).toHaveLength(2)
    // Second clause is the term "bread"
    expect((g.clauses[1]! as SearchClause & { term: SearchTerm }).term.text).toBe('bread')
  })

  test('multiple AND terms → one AND group', () => {
    const ast = parseSearchQuery('a AND b AND c')
    const g = ast[0]! as SearchClause & { type: 'group'; combine: 'AND' | 'OR'; clauses: SearchClause[] }
    expect(g.type).toBe('group')
    expect(g.combine).toBe('AND')
    expect(g.clauses).toHaveLength(3)
  })

  test('mixed AND/OR → nested structure', () => {
    const ast = parseSearchQuery('a AND b OR c AND d')
    // Top-level: OR of two AND groups
    expect(ast).toHaveLength(2)
    const g1 = ast[0]! as SearchClause & { type: 'group'; combine: 'AND' | 'OR' }
    const g2 = ast[1]! as SearchClause & { type: 'group'; combine: 'AND' | 'OR' }
    expect(g1.combine).toBe('AND')
    expect(g2.combine).toBe('AND')
    expect(g1.clauses).toHaveLength(2)
    expect(g2.clauses).toHaveLength(2)
  })

  test('unbalanced quote → degrade to literal terms', () => {
    const ast = parseSearchQuery('"garlic bread')
    // Should not throw, should produce some terms
    expect(ast.length).toBeGreaterThan(0)
    for (const clause of ast) {
      expect((clause as SearchClause & { term: SearchTerm }).term.text).toContain('"garlic')
    }
  })

  test('unbalanced paren → degrade to literal terms', () => {
    const ast = parseSearchQuery('(lentil soup')
    expect(ast.length).toBeGreaterThan(0)
    // Should not throw
  })

  test('unbalanced closing paren → degrade to literal terms', () => {
    const ast = parseSearchQuery('lentil soup)')
    expect(ast.length).toBeGreaterThan(0)
  })

  test('case-sensitivity: AND vs and', () => {
    const astUpper = parseSearchQuery('lentil AND soup')
    const astLower = parseSearchQuery('lentil and soup')
    // Upper: AND is an explicit operator → one group, explicit=true
    expect(astUpper).toHaveLength(1)
    expect((astUpper[0]! as SearchClause & { type: 'group' }).type).toBe('group')
    expect(((astUpper[0]! as SearchClause & { type: 'group' }).explicit)).toBe(true)
    expect(((astUpper[0]! as SearchClause & { type: 'group' }).clauses)).toHaveLength(2)
    // Lower: and is a term → one group with 3 clauses, explicit=false
    expect(astLower).toHaveLength(1)
    expect((astLower[0]! as SearchClause & { type: 'group' }).type).toBe('group')
    expect(((astLower[0]! as SearchClause & { type: 'group' }).explicit)).toBe(false)
    expect(((astLower[0]! as SearchClause & { type: 'group' }).clauses)).toHaveLength(3)
  })

  test('phrase with multiple words → single exact term', () => {
    const ast = parseSearchQuery('"chicken soup"')
    const t = (ast[0]! as SearchClause & { term: SearchTerm }).term
    expect(t.text).toBe('chicken soup')
    expect(t.exact).toBe(true)
  })

  test('phrase combined with AND', () => {
    const ast = parseSearchQuery('"garlic bread" AND soup')
    expect(ast).toHaveLength(1)
    const g = ast[0]! as SearchClause & { type: 'group'; combine: 'AND' | 'OR'; clauses: SearchClause[] }
    expect(g.type).toBe('group')
    expect(g.combine).toBe('AND')
    expect(g.clauses).toHaveLength(2)
    expect((g.clauses[0]! as SearchClause & { term: SearchTerm }).term.text).toBe('garlic bread')
    expect((g.clauses[1]! as SearchClause & { term: SearchTerm }).term.text).toBe('soup')
  })
})

// ── AND + OR fallback tests ─────────────────────────────────────────────────

function makeMeta(id: number, name: string, ingredients: string[]): VariantMeta {
  return {
    id,
    name,
    is_pro: false,
    is_secret: false,
    macros: { fats: 0, carbs: 0, protein: 0 },
    rating: 0,
    rating_count: 0,
    popularity: {},
    calories: 0,
    sodium_mg: 0,
    cooking_minutes: 0,
    serving_count: 6,
    ingredient_names: ingredients,
    variety_tag_ids: [],
    price_per_serving: null,
    thumbnail_image_url: '',
    presentation_image_url: '',
    first_published_at: 0,
    ruleset: 'dinner',
  }
}

describe('searchWithIndex AND/OR fallback', () => {
  test('bare query → AND primary', async () => {
    // "garlic soup" → AND finds docs matching BOTH garlic AND soup
    // Only one doc has both → primary = [1]
    const docs = [
      buildSearchDoc(makeMeta(1, 'Garlic Soup', ['garlic', 'onion', 'broth'])),
      buildSearchDoc(makeMeta(2, 'Garlic Bread', ['garlic', 'bread', 'butter'])),
      buildSearchDoc(makeMeta(3, 'Tomato Soup', ['tomato', 'onion', 'broth'])),
    ]
    const index = new MiniSearch<SearchDoc>(INDEX_OPTIONS)
    index.addAll(docs)
    const c = {
      byId: new Map(docs.map((d) => [d.id, d as unknown as VariantMeta])),
      userRecipeIds: new Set<number>(),
    }
    // searchWithIndex doesn't need the full catalog, just the docs for adjacency
    // But getSearchIndex needs catalog, so we use searchWithIndex directly
    void c // unused but type-checks
    const result = await searchWithIndex(index, 'garlic soup', docs)
    // AND of "garlic" and "soup" → only doc 1 (Garlic Soup) matches both
    expect(result.primary).toContain(1)
    // Doc 2 has garlic but not soup → not in primary
    expect(result.primary).not.toContain(2)
    // Doc 3 has soup but not garlic → not in primary
    expect(result.primary).not.toContain(3)
  })

  test('bare query → OR fallback when primary < display window', async () => {
    const docs = [
      buildSearchDoc(makeMeta(1, 'Garlic Soup', ['garlic', 'onion', 'broth'])),
      buildSearchDoc(makeMeta(2, 'Garlic Bread', ['garlic', 'bread', 'butter'])),
      buildSearchDoc(makeMeta(3, 'Tomato Soup', ['tomato', 'onion', 'broth'])),
    ]
    const index = new MiniSearch<SearchDoc>(INDEX_OPTIONS)
    index.addAll(docs)
    const result = await searchWithIndex(index, 'garlic soup', docs)
    // Primary: AND matches → doc 1 only
    expect(result.primary).toHaveLength(1)
    expect(result.primary).toContain(1)
    // Fallback: OR matches not in primary → docs 2, 3
    expect(result.fallback).toContain(2)
    expect(result.fallback).toContain(3)
  })

  test('bare query → no fallback when primary >= display window', async () => {
    // Create 201 docs, all matching "garlic" so AND primary is large
    const docs: VariantMeta[] = []
    const searchDocs: SearchDoc[] = []
    for (let i = 0; i < 201; i++) {
      const id = i + 1
      docs.push(makeMeta(id, `Recipe ${id} garlic`, ['garlic']))
      searchDocs.push(buildSearchDoc(docs[i]))
    }
    const index = new MiniSearch<SearchDoc>(INDEX_OPTIONS)
    index.addAll(searchDocs)
    const result = await searchWithIndex(index, 'garlic', searchDocs)
    // Primary: all 201 docs match "garlic" (AND of single term = all)
    expect(result.primary.length).toBeGreaterThanOrEqual(200)
    expect(result.fallback).toHaveLength(0)
  })

  test('explicit operator query → no fallback', async () => {
    const docs = [
      buildSearchDoc(makeMeta(1, 'Garlic Soup', ['garlic', 'onion', 'broth'])),
      buildSearchDoc(makeMeta(2, 'Garlic Bread', ['garlic', 'bread', 'butter'])),
    ]
    const index = new MiniSearch<SearchDoc>(INDEX_OPTIONS)
    index.addAll(docs)
    const result = await searchWithIndex(index, 'garlic AND soup', docs)
    expect(result.primary).toContain(1)
    expect(result.primary).not.toContain(2)
    expect(result.fallback).toHaveLength(0)
  })

  test('explicit OR query → no fallback', async () => {
    const docs = [
      buildSearchDoc(makeMeta(1, 'Garlic Soup', ['garlic', 'onion', 'broth'])),
      buildSearchDoc(makeMeta(2, 'Garlic Bread', ['garlic', 'bread', 'butter'])),
      buildSearchDoc(makeMeta(3, 'Tomato Soup', ['tomato', 'onion', 'broth'])),
    ]
    const index = new MiniSearch<SearchDoc>(INDEX_OPTIONS)
    index.addAll(docs)
    const result = await searchWithIndex(index, 'garlic OR soup', docs)
    expect(result.primary).toContain(1)
    expect(result.primary).toContain(2)
    expect(result.primary).toContain(3)
    expect(result.fallback).toHaveLength(0)
  })

  test('-exclusion removes results', async () => {
    const docs = [
      buildSearchDoc(makeMeta(1, 'Garlic Soup', ['garlic', 'onion', 'broth'])),
      buildSearchDoc(makeMeta(2, 'Garlic Bread', ['garlic', 'bread', 'butter'])),
    ]
    const index = new MiniSearch<SearchDoc>(INDEX_OPTIONS)
    index.addAll(docs)
    const result = await searchWithIndex(index, 'garlic -soup', docs)
    // "garlic" matches both, but "soup" is excluded → only doc 2
    expect(result.primary).toHaveLength(1)
    expect(result.primary).toContain(2)
    expect(result.primary).not.toContain(1)
  })
})

// ── Phrase adjacency tests ───────────────────────────────────────────────────

describe('phrase adjacency', () => {
  test('adjacent in name → included', async () => {
    const docs = [buildSearchDoc(makeMeta(1, 'Garlic Bread', ['garlic', 'bread']))]
    const index = new MiniSearch<SearchDoc>(INDEX_OPTIONS)
    index.addAll(docs)
    const result = await searchWithIndex(index, '"garlic bread"', docs)
    expect(result.primary).toContain(1)
  })

  test('not adjacent in name but adjacent in ingredients → included', async () => {
    // "garlic bread" as a phrase: terms are adjacent in ingredients list
    const docs = [buildSearchDoc(makeMeta(1, 'Bread with Garlic', ['garlic', 'bread', 'butter']))]
    const index = new MiniSearch<SearchDoc>(INDEX_OPTIONS)
    index.addAll(docs)
    const result = await searchWithIndex(index, '"garlic bread"', docs)
    // Terms "garlic" and "bread" are adjacent in ingredients → included
    expect(result.primary).toContain(1)
  })

  test('neither adjacent nor together → excluded', async () => {
    // "garlic bread" — neither in name nor ingredients are they adjacent
    const docs = [buildSearchDoc(makeMeta(1, 'Bread and Garlic', ['tomato', 'garlic', 'onion']))]
    const index = new MiniSearch<SearchDoc>(INDEX_OPTIONS)
    index.addAll(docs)
    const result = await searchWithIndex(index, '"garlic bread"', docs)
    // "garlic" and "bread" are not adjacent in name ("Bread and Garlic") nor in ingredients
    expect(result.primary).not.toContain(1)
  })

  test('single-word phrase → always adjacent', async () => {
    const docs = [buildSearchDoc(makeMeta(1, 'Garlic', ['garlic']))]
    const index = new MiniSearch<SearchDoc>(INDEX_OPTIONS)
    index.addAll(docs)
    const result = await searchWithIndex(index, '"garlic"', docs)
    expect(result.primary).toContain(1)
  })
})

// ── Suggest tests ────────────────────────────────────────────────────────────

describe('suggest', () => {
  test('empty query → empty suggestions', async () => {
    const result = await suggest('')
    expect(result).toHaveLength(0)
  })

  test('returns suggestions for partial terms', async () => {
    const docs = [
      buildSearchDoc(makeMeta(1, 'Chicken Soup', ['chicken', 'broth'])),
      buildSearchDoc(makeMeta(2, 'Chicken Salad', ['chicken', 'lettuce'])),
      buildSearchDoc(makeMeta(3, 'Chicken Parmesan', ['chicken', 'parmesan'])),
    ]
    const index = new MiniSearch<SearchDoc>(INDEX_OPTIONS)
    index.addAll(docs)
    // We can't easily test suggest() directly since it uses getSearchIndex()
    // which needs the catalog. Instead, we test autoSuggest directly.
    const results = index.autoSuggest('chick', {
      fields: ['name'],
      combineWith: 'AND',
      boost: { name: 2 },
      prefix: true,
    })
    expect(results.length).toBeGreaterThan(0)
    const suggestions = results.map((r) => r.suggestion)
    expect(suggestions.some((s) => s.toLowerCase().includes('chicken'))).toBe(true)
  })

  test('no matches → empty suggestions', async () => {
    const docs = [buildSearchDoc(makeMeta(1, 'Chicken Soup', ['chicken', 'broth']))]
    const index = new MiniSearch<SearchDoc>(INDEX_OPTIONS)
    index.addAll(docs)
    const results = index.autoSuggest('zzzz', {
      fields: ['name'],
      combineWith: 'AND',
      boost: { name: 2 },
      prefix: true,
    })
    expect(results).toHaveLength(0)
  })
})

// ── Helper to make MiniSearch work with bun:test ────────────────────────────
