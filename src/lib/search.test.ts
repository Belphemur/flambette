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

  test('-term at very start → negated (subtracts from whole catalog)', () => {
    const ast = parseSearchQuery('-lentil')
    const t = (ast[0]! as SearchClause & { term: SearchTerm }).term
    expect(t.text).toBe('lentil')
    expect(t.negate).toBe(true)
    expect(t.exact).toBe(true)
  })

  test('-"phrase" → negated exact phrase (sign sticks to the quotes)', () => {
    const ast = parseSearchQuery('soup -"garlic bread"')
    const g = ast[0]! as SearchClause & { type: 'group'; clauses: SearchClause[] }
    const neg = (g.clauses[1]! as SearchClause & { term: SearchTerm }).term
    expect(neg.negate).toBe(true)
    expect(neg.exact).toBe(true)
    expect(neg.text).toBe('garlic bread')
  })

  test('(lentil AND soup) → AND group, AND not a literal term', () => {
    const ast = parseSearchQuery('(lentil AND soup)')
    const g = ast[0]! as SearchClause & { type: 'group'; combine: 'AND' | 'OR'; explicit: boolean; clauses: SearchClause[] }
    expect(g.combine).toBe('AND')
    expect(g.explicit).toBe(true)
    expect(g.clauses).toHaveLength(2)
    expect((g.clauses[0]! as SearchClause & { term: SearchTerm }).term.text).toBe('lentil')
    expect((g.clauses[1]! as SearchClause & { term: SearchTerm }).term.text).toBe('soup')
  })

  test('(lentil soup) → implicit AND inside parens (same grammar)', () => {
    const ast = parseSearchQuery('(lentil soup)')
    const g = ast[0]! as SearchClause & { type: 'group'; combine: 'AND' | 'OR'; explicit: boolean }
    expect(g.combine).toBe('AND')
    expect(g.explicit).toBe(false)
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

// ── Review-fix behaviours (PR #58 follow-up) ────────────────────────────────

describe('review fixes: negation, groups, adjacency scope', () => {
  function makeIndex(docs: SearchDoc[]): MiniSearch<SearchDoc> {
    const index = new MiniSearch<SearchDoc>(INDEX_OPTIONS)
    index.addAll(docs)
    return index
  }

  test('negated term is exact: -pea does not remove peanut/pear', async () => {
    const docs = [
      buildSearchDoc(makeMeta(1, 'Chicken & Pea Stew', ['chicken', 'pea'])),
      // Both contain "chicken" TOO — so the AND admits them and only the
      // negation decides; a fuzzy `-pea` regression would remove them and
      // the test would catch it (docs without "chicken" are excluded by
      // the positive term regardless, which proves nothing).
      buildSearchDoc(makeMeta(2, 'Chicken Peanut Noodles', ['chicken', 'peanut'])),
      buildSearchDoc(makeMeta(3, 'Chicken Pear Salad', ['chicken', 'pear'])),
      buildSearchDoc(makeMeta(4, 'Plain Chicken', ['chicken'])),
    ]
    const index = makeIndex(docs)
    const result = await searchWithIndex(index, 'chicken -pea', docs)
    expect(result.primary).toContain(4)
    expect(result.primary).not.toContain(1) // pea excluded (exact)
    expect(result.primary).toContain(2) // peanut NOT excluded by -pea
    expect(result.primary).toContain(3) // pear NOT excluded by -pea
  })

  test('query that is only negations → whole catalog minus the negation', async () => {
    const docs = [
      buildSearchDoc(makeMeta(1, 'Garlic Soup', ['garlic'])),
      buildSearchDoc(makeMeta(2, 'Garlic Bread', ['garlic', 'bread'])),
    ]
    const index = makeIndex(docs)
    const result = await searchWithIndex(index, '-bread', docs)
    expect(result.primary).toContain(1)
    expect(result.primary).not.toContain(2)
  })

  test('leading -soup excludes soups instead of searching for them', async () => {
    const docs = [
      buildSearchDoc(makeMeta(1, 'Tomato Soup', ['tomato'])),
      buildSearchDoc(makeMeta(2, 'Tomato Salad', ['tomato'])),
    ]
    const index = makeIndex(docs)
    const result = await searchWithIndex(index, '-soup', docs)
    expect(result.primary).toContain(2)
    expect(result.primary).not.toContain(1)
  })

  test('AND inside parentheses is an operator, not a fuzzy term', async () => {
    const docs = [
      buildSearchDoc(makeMeta(1, 'Lentil Soup', ['lentil', 'broth'])),
      buildSearchDoc(makeMeta(2, 'Lentil Salad', ['lentil'])),
      buildSearchDoc(makeMeta(3, 'Mushroom Soup', ['mushroom', 'broth'])),
    ]
    const index = makeIndex(docs)
    const result = await searchWithIndex(index, '(lentil AND soup)', docs)
    expect(result.primary).toContain(1)
    expect(result.primary).not.toContain(2) // lentil only
    expect(result.primary).not.toContain(3) // soup only
  })

  test('phrase inside a group requires adjacency', async () => {
    const docs = [
      // garlic and bread present but NOT adjacent; soup absent
      buildSearchDoc(makeMeta(1, 'Bread and Garlic', ['garlic', 'bread'])),
      buildSearchDoc(makeMeta(2, 'Garlic Bread & Soup', ['garlic', 'bread', 'soup'])),
    ]
    const index = makeIndex(docs)
    const result = await searchWithIndex(index, '"garlic bread" AND soup', docs)
    expect(result.primary).toContain(2)
    expect(result.primary).not.toContain(1)
  })

  test('phrase OR term does not filter the other branch by the phrase', async () => {
    const docs = [
      buildSearchDoc(makeMeta(1, 'Garlic Bread', ['garlic', 'bread'])),
      buildSearchDoc(makeMeta(2, 'Tomato Soup', ['tomato'])), // soup only
    ]
    const index = makeIndex(docs)
    const result = await searchWithIndex(index, '"garlic bread" OR soup', docs)
    expect(result.primary).toContain(1)
    expect(result.primary).toContain(2)
  })

  test('phrase next to a bare term takes the explicit path (exact, adjacent)', async () => {
    const docs = [
      buildSearchDoc(makeMeta(1, 'Garlic Bread Soup', ['garlic', 'bread', 'broth'])),
      // all three words present but the phrase is adjacent in NEITHER the
      // name nor the ingredients
      buildSearchDoc(makeMeta(2, 'Bread, Garlic, and Soup', ['tomato', 'garlic', 'onion'])),
    ]
    const index = makeIndex(docs)
    const result = await searchWithIndex(index, '"garlic bread" soup', docs)
    expect(result.primary).toContain(1)
    expect(result.primary).not.toContain(2)
  })

  test('+term next to a bare term keeps its exact flag', async () => {
    const docs = [
      buildSearchDoc(makeMeta(1, 'Lentil Soup', ['lentil'])),
      // fuzzy neighbour of "lentil" — must NOT match +lentil
      buildSearchDoc(makeMeta(2, 'Lentilz Loaf', ['lentilz'])),
    ]
    const index = makeIndex(docs)
    const result = await searchWithIndex(index, '+lentil soup', docs)
    expect(result.primary).toContain(1)
    expect(result.primary).not.toContain(2)
  })

  test('term* next to a bare term is prefix-only (no fuzzy)', async () => {
    const docs = [
      buildSearchDoc(makeMeta(1, 'Lentil Soup', ['lentil'])),
      buildSearchDoc(makeMeta(2, 'Lentilz Loaf', ['lentilz'])),
    ]
    const index = makeIndex(docs)
    const result = await searchWithIndex(index, 'lentil* soup', docs)
    // lentil* is prefix-only: matches both 1 (prefix) — 2 matches the
    // prefix too, but its "loaf" has no soup → AND with soup keeps only 1
    expect(result.primary).toContain(1)
    expect(result.primary).not.toContain(2)
  })

  test('adjacency ignores punctuation (Tomato Soup, Basil)', async () => {
    const docs = [
      buildSearchDoc(makeMeta(1, 'Tomato Soup, Basil', ['tomato', 'basil'])),
    ]
    const index = makeIndex(docs)
    const result = await searchWithIndex(index, '"tomato soup"', docs)
    expect(result.primary).toContain(1)
  })

  test('negated OR branch: soup OR -bread keeps soup recipes with bread', async () => {
    const docs = [
      buildSearchDoc(makeMeta(1, 'Tomato Soup with Bread', ['tomato', 'bread'])),
      buildSearchDoc(makeMeta(2, 'Tomato Soup', ['tomato'])),
      buildSearchDoc(makeMeta(3, 'Plain Bread', ['bread'])),
    ]
    const index = makeIndex(docs)
    // Branch 1: soup matches (1, 2). Branch 2: catalog minus bread (2).
    // A global subtraction would drop 1 — wrong: its soup branch qualifies.
    const result = await searchWithIndex(index, 'soup OR -bread', docs)
    expect(result.primary).toContain(1)
    expect(result.primary).toContain(2)
    expect(result.primary).not.toContain(3)
  })

  test('-soup -bread: multiple negations subtract from the catalog', async () => {
    const docs = [
      buildSearchDoc(makeMeta(1, 'Tomato Soup', ['tomato'])),
      buildSearchDoc(makeMeta(2, 'Plain Bread', ['bread'])),
      buildSearchDoc(makeMeta(3, 'Tomato Salad', ['tomato'])),
    ]
    const index = makeIndex(docs)
    // Implicit-AND group of two negations: positive-LESS group contributes
    // catalog minus both, not [].
    const result = await searchWithIndex(index, '-soup -bread', docs)
    expect(result.primary).toContain(3)
    expect(result.primary).not.toContain(1)
    expect(result.primary).not.toContain(2)
  })

  test('soup (-onion -garlic): positive-less subgroup does not collapse the AND', async () => {
    const docs = [
      buildSearchDoc(makeMeta(1, 'Leek Soup', ['leek'])),
      buildSearchDoc(makeMeta(2, 'Onion Soup', ['onion'])),
      buildSearchDoc(makeMeta(3, 'Garlic Bread', ['garlic', 'bread'])),
    ]
    const index = makeIndex(docs)
    // The subgroup (-onion -garlic) has no positives: it yields catalog
    // minus {2,3}; intersecting with soup keeps 1 — returning [] there
    // zeroed the whole query.
    const result = await searchWithIndex(index, 'soup (-onion -garlic)', docs)
    expect(result.primary).toContain(1)
    expect(result.primary).not.toContain(2)
    expect(result.primary).not.toContain(3)
  })

  test('bare AND primary is literal: "pork" does not fuzzy-match "york"', async () => {
    const docs = [
      // has "rice" (jasmine rice) and "york" — NO pork token
      buildSearchDoc(makeMeta(1, 'Baked Sesame Beef with Broccoli & Rice', [
        'broccoli', 'jasmine rice', 'striploin (New York strip) steak', 'sesame seeds',
      ])),
      buildSearchDoc(makeMeta(2, 'Pork & Rice Bowl', ['pork', 'jasmine rice'])),
    ]
    const index = makeIndex(docs)
    const result = await searchWithIndex(index, 'rice pork', docs)
    expect(result.primary).toContain(2)
    // "york" is within fuzzy 0.2 of "pork" (1 edit on 4 letters) — the
    // AND primary must not accept it; the fuzzy match may only appear
    // in the OR fallback below the divider.
    expect(result.primary).not.toContain(1)
    expect(result.fallback).toContain(1)
  })
})
