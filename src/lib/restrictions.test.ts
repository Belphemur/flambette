import { describe, expect, test } from 'bun:test'
import {
  RESTRICTIONS,
  activeDrops,
  buildLadderIndex,
  ensurePair,
  ensureRemoved,
  ensureSwaps,
  groceryDisplayLines,
  isDropName,
  isRemovedByRestriction,
  normalizeRestrictionIds,
  restrictedDocView,
  swapName,
} from './restrictions'
import { nameKey } from './grocery'

/* ---------- Constants & test data ---------- */

const GF_ID = 1
const DF_ID = 2
const PAIR_KEY = 'dairy-free-gluten-free'

/** A minimal LadderIndex with swaps and drops loaded (from swaps.json shape). */
function indexWithSwaps(swaps: typeof import('./restrictions').SwapEntry[], drops: typeof import('./restrictions').DropEntry[]) {
  const idx = buildLadderIndex()
  idx.swaps = swaps
  idx.drops = drops
  return idx
}

/** A LadderIndex with removed data loaded for specific slugs. */
function indexWithRemoved(removedData: Record<string, number[]>) {
  const idx = buildLadderIndex()
  for (const [slug, ids] of Object.entries(removedData)) {
    idx.removed.set(slug, ids)
  }
  return idx
}

/** A LadderIndex with pair extras loaded for specific pair keys. */
function indexWithPairs(pairData: Record<string, number[]>) {
  const idx = buildLadderIndex()
  for (const [key, ids] of Object.entries(pairData)) {
    idx.pairs.set(key, ids)
  }
  return idx
}

const sampleSwaps = [
  { from: 'soy sauce', to: 'tamari soy sauce', quantityRule: 'verbatim', count: 283 },
  { from: 'rotini pasta', to: 'gluten free rotini pasta', quantityRule: 'verbatim', count: 43 },
  { from: 'fettuccine pasta', to: 'gluten free fettuccine pasta', quantityRule: 'verbatim', count: 16 },
  { from: 'butter, unsalted', to: 'virgin coconut oil', quantityRule: 'verbatim', count: 5 },
  { from: 'mayonnaise', to: 'avocado oil mayonnaise', quantityRule: 'verbatim', count: 3 },
]

const sampleDrops = [
  { from: 'crumbled feta cheese', count: 41 },
  { from: 'butter, unsalted', count: 63 },
]

const sampleRemovedGF = [50, 60, 195, 224, 863] // GF removes these recipe ids
const sampleRemovedDF = []
const sampleExtras110 = [70] // Pair GF+DF removes rid 70 (extra beyond singles)

/* ---------- RESTRICTIONS ---------- */

describe('RESTRICTIONS', () => {
  test('twelve entries in display order, unique ids and slugs', () => {
    expect(RESTRICTIONS).toHaveLength(12)
    expect(RESTRICTIONS.map((r) => r.slug)).toEqual([
      'shellfish-free', 'fish-free', 'gluten-free', 'dairy-free', 'peanut-free',
      'tree-nut-free', 'soy-free', 'egg-free', 'sesame-free', 'mustard-free',
      'sulfite-free', 'nightshade-free',
    ])
    expect(new Set(RESTRICTIONS.map((r) => r.id)).size).toBe(12)
  })
})

/* ---------- normalizeRestrictionIds ---------- */

describe('normalizeRestrictionIds', () => {
  test('drops unknown ids, dedupes, sorts ascending', () => {
    expect(normalizeRestrictionIds([10, 1, 99, 1, '3'])).toEqual([1, 3, 10])
  })
  test('non-arrays and junk return []', () => {
    expect(normalizeRestrictionIds(undefined)).toEqual([])
    expect(normalizeRestrictionIds('gluten-free')).toEqual([])
    expect(normalizeRestrictionIds([1.5, -3, null, {}])).toEqual([])
  })
  test('numeric strings of known ids are accepted', () => {
    expect(normalizeRestrictionIds(['1', '14'])).toEqual([1, 14])
    expect(normalizeRestrictionIds(['0', '15'])).toEqual([])
  })
})

/* ---------- buildLadderIndex ---------- */

describe('buildLadderIndex', () => {
  test('returns empty index with null swaps and drops', () => {
    const idx = buildLadderIndex()
    expect(idx.swaps).toBeNull()
    expect(idx.drops).toBeNull()
    expect(idx.removed.size).toBe(0)
    expect(idx.pairs.size).toBe(0)
    expect(idx.restrictions).toHaveLength(12)
  })
})

/* ---------- ensureSwaps (ladder) ---------- */

describe('ensureSwaps (ladder)', () => {
  test('loads swaps and drops from injected fetch', async () => {
    const idx = buildLadderIndex()
    const fetchImpl = async (_url: string) =>
      new Response(JSON.stringify({ swaps: sampleSwaps, drops: sampleDrops }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    await ensureSwaps(idx, fetchImpl, '/base/')
    expect(idx.swaps).toHaveLength(5)
    expect(idx.drops).toHaveLength(2)
    expect(idx.swaps![0].from).toBe('soy sauce')
  })
  test('is cached (no second fetch on re-call)', async () => {
    const idx = buildLadderIndex()
    let calls = 0
    const fetchImpl = async () => {
      calls++
      return new Response(JSON.stringify({ swaps: sampleSwaps, drops: sampleDrops }), { status: 200 })
    }
    await ensureSwaps(idx, fetchImpl, '/base/')
    await ensureSwaps(idx, fetchImpl, '/base/')
    expect(calls).toBe(1)
  })
  test('failed fetch leaves swaps null (identity display)', async () => {
    const idx = buildLadderIndex()
    const fetchImpl = async () => new Response('nope', { status: 404 })
    await ensureSwaps(idx, fetchImpl, '/')
    expect(idx.swaps).toBeNull()
    expect(idx.drops).toBeNull()
  })
  test('failed fetch is retried on next call', async () => {
    const idx = buildLadderIndex()
    let calls = 0
    const fetchImpl = async () => {
      calls++
      if (calls < 2) return new Response('nope', { status: 404 })
      return new Response(JSON.stringify({ swaps: sampleSwaps, drops: sampleDrops }), { status: 200 })
    }
    await ensureSwaps(idx, fetchImpl, '/')
    expect(idx.swaps).toBeNull() // first call failed
    await ensureSwaps(idx, fetchImpl, '/') // second call succeeds
    expect(idx.swaps).not.toBeNull()
    expect(idx.swaps!.length).toBe(5)
  })
})

/* ---------- ensureRemoved (ladder) ---------- */

describe('ensureRemoved (ladder)', () => {
  test('loads removed ids for a slug from injected fetch', async () => {
    const idx = buildLadderIndex()
    const fetchImpl = async (_url: string) =>
      new Response(JSON.stringify({ removed: sampleRemovedGF }), { status: 200 })
    await ensureRemoved('gluten-free', idx, fetchImpl, '/base/')
    expect(idx.removed.get('gluten-free')).toEqual(sampleRemovedGF)
  })
  test('is cached (no second fetch on re-call)', async () => {
    const idx = buildLadderIndex()
    let calls = 0
    const fetchImpl = async () => {
      calls++
      return new Response(JSON.stringify({ removed: [1, 2, 3] }), { status: 200 })
    }
    await ensureRemoved('gluten-free', idx, fetchImpl, '/base/')
    await ensureRemoved('gluten-free', idx, fetchImpl, '/base/')
    expect(calls).toBe(1)
  })
  test('failed fetch leaves empty list (identity display)', async () => {
    const idx = buildLadderIndex()
    const fetchImpl = async () => new Response('nope', { status: 404 })
    await ensureRemoved('gluten-free', idx, fetchImpl, '/')
    expect(idx.removed.get('gluten-free')).toEqual([])
  })
})

/* ---------- ensurePair (ladder) ---------- */

describe('ensurePair (ladder)', () => {
  test('loads pair extras from injected fetch', async () => {
    const idx = buildLadderIndex()
    const fetchImpl = async (_url: string) =>
      new Response(JSON.stringify({ extras: sampleExtras110 }), { status: 200 })
    await ensurePair('gluten-free', 'dairy-free', idx, fetchImpl, '/base/')
    expect(idx.pairs.get(PAIR_KEY)).toEqual(sampleExtras110)
  })
  test('pair key is canonical (a < b ordering)', async () => {
    const idx = buildLadderIndex()
    const fetchImpl = async () => new Response(JSON.stringify({ extras: [1, 2] }), { status: 200 })
    // REVERSE order — should still store under canonical key (dairy-free-gluten-free)
    await ensurePair('gluten-free', 'dairy-free', idx, fetchImpl, '/base/')
    expect(idx.pairs.get(PAIR_KEY)).toEqual([1, 2])
    expect(idx.pairs.has('dairy-free-gluten-free')).toBe(true)
    expect(idx.pairs.has('gluten-free-dairy-free')).toBe(false)
  })
  test('is cached (no second fetch on re-call)', async () => {
    const idx = buildLadderIndex()
    let calls = 0
    const fetchImpl = async () => {
      calls++
      return new Response(JSON.stringify({ extras: [1] }), { status: 200 })
    }
    await ensurePair('gluten-free', 'dairy-free', idx, fetchImpl, '/base/')
    await ensurePair('gluten-free', 'dairy-free', idx, fetchImpl, '/base/')
    expect(calls).toBe(1)
  })
  test('failed fetch leaves empty list', async () => {
    const idx = buildLadderIndex()
    const fetchImpl = async () => new Response('nope', { status: 404 })
    await ensurePair('dairy-free', 'gluten-free', idx, fetchImpl, '/')
    expect(idx.pairs.get(PAIR_KEY)).toEqual([])
  })
})

/* ---------- isRemovedByRestriction (ladder) ---------- */

describe('isRemovedByRestriction (ladder)', () => {
  test('a removed id under an active restriction is gone', () => {
    const idx = indexWithRemoved({ 'gluten-free': sampleRemovedGF })
    expect(isRemovedByRestriction(50, [GF_ID], idx)).toBe(true)
    expect(isRemovedByRestriction(50, [], idx)).toBe(false)
    expect(isRemovedByRestriction(50, [DF_ID], idx)).toBe(false)
  })
  test('pair extras remove when the pair is active', () => {
    const idx = indexWithRemoved({ 'gluten-free': [], 'dairy-free': [] })
    idx.pairs.set(PAIR_KEY, sampleExtras110)
    expect(isRemovedByRestriction(70, [GF_ID, DF_ID], idx)).toBe(true)
    // Only one of the pair is NOT enough
    expect(isRemovedByRestriction(70, [GF_ID], idx)).toBe(false)
    expect(isRemovedByRestriction(70, [DF_ID], idx)).toBe(false)
  })
  test('the union over several active ids removes if ANY does', () => {
    const idx = indexWithRemoved({ 'gluten-free': [60] })
    expect(isRemovedByRestriction(60, [GF_ID, DF_ID], idx)).toBe(true)
    expect(isRemovedByRestriction(80, [GF_ID, DF_ID], idx)).toBe(false)
  })
  test('unknown ids and absent sets never remove', () => {
    const idx = buildLadderIndex()
    expect(isRemovedByRestriction(50, [7], idx)).toBe(false)
  })
  test('empty index never removes', () => {
    expect(isRemovedByRestriction(50, [1], buildLadderIndex())).toBe(false)
  })
})

/* ---------- swapName (ladder) ---------- */

describe('swapName (ladder)', () => {
  test('returns the substitute when a swap matches the nameKey', () => {
    const idx = indexWithSwaps(sampleSwaps, sampleDrops)
    expect(swapName('soy sauce', idx)).toBe('tamari soy sauce')
    expect(swapName('rotini pasta', idx)).toBe('gluten free rotini pasta')
    expect(swapName('fettuccine pasta', idx)).toBe('gluten free fettuccine pasta')
    expect(swapName('butter, unsalted', idx)).toBe('virgin coconut oil')
  })
  test('returns the original when no swap matches', () => {
    const idx = indexWithSwaps(sampleSwaps, sampleDrops)
    expect(swapName('broccoli', idx)).toBe('broccoli')
    expect(swapName('garlic', idx)).toBe('garlic')
  })
  test('nameKey matching is case-insensitive', () => {
    const idx = indexWithSwaps(sampleSwaps, sampleDrops)
    expect(swapName('SOY SAUCE', idx)).toBe('tamari soy sauce')
  })
  test('pre-load: returns original when swaps not loaded', () => {
    const idx = buildLadderIndex() // swaps is null
    expect(swapName('soy sauce', idx)).toBe('soy sauce')
  })
})

/* ---------- isDropName ---------- */

describe('isDropName', () => {
  test('returns true for nameKeys in the drops set', () => {
    const drops = activeDrops([DF_ID], indexWithSwaps(sampleSwaps, sampleDrops))
    expect(isDropName('crumbled feta cheese', drops)).toBe(true)
  })
  test('returns false for nameKeys not in the drops set', () => {
    const drops = activeDrops([DF_ID], indexWithSwaps(sampleSwaps, sampleDrops))
    expect(isDropName('broccoli', drops)).toBe(false)
  })
})

/* ---------- activeDrops (ladder) ---------- */

describe('activeDrops (ladder)', () => {
  test('returns empty set when no restrictions are active', () => {
    const idx = indexWithSwaps(sampleSwaps, sampleDrops)
    expect(activeDrops([], idx).size).toBe(0)
  })
  test('returns union of drops across active restrictions', () => {
    const idx = indexWithSwaps(sampleSwaps, sampleDrops)
    const drops = activeDrops([DF_ID], idx)
    expect(drops.has(nameKey('crumbled feta cheese'))).toBe(true)
  })
  test('empty drops list returns empty set', () => {
    const idx = buildLadderIndex() // drops is null
    expect(activeDrops([GF_ID], idx).size).toBe(0)
  })
})

/* ---------- restrictedDocView (ladder) ---------- */

describe('restrictedDocView (ladder)', () => {
  const baseDoc = {
    id: 40001,
    recipe_id: 400,
    serving_count: 6,
    cooking_minutes: 20,
    name: 'Test Bowl',
    slug: 'test-bowl',
    units: 'Metric',
    thumbnail_image_url: '',
    presentation_image_url: '',
    cookwares: [],
    instructions: [{ id: 1, primary_message: 'Boil the rotini pasta.', secondary_message: null }],
    line_items: [
      { id: 11, quantity: '15 oz', ingredient_name: 'rotini pasta' },
      { id: 12, quantity: '2 tbsp', ingredient_name: 'soy sauce' },
      { id: 13, quantity: '300 g', ingredient_name: 'broccoli' },
    ],
    nutrition: { energy: 0, carbs: 0, fiber: 0, sugars: 0, fat: 0, protein: 0, sodium: 0 },
  }

  test('applies swaps to ingredient names, keeps base quantities and ids', () => {
    const view = restrictedDocView(baseDoc, indexWithSwaps(sampleSwaps, sampleDrops), [GF_ID])
    expect(view.line_items.map((l) => l.ingredient_name)).toEqual([
      'gluten free rotini pasta', 'tamari soy sauce', 'broccoli',
    ])
    expect(view.line_items.map((l) => l.quantity)).toEqual(['15 oz', '2 tbsp', '300 g'])
    expect(view.line_items.map((l) => l.id)).toEqual([11, 12, 13])
  })
  test('recipe prose stays AUTHENTIC — no substitution in instructions', () => {
    const view = restrictedDocView(baseDoc, indexWithSwaps(sampleSwaps, sampleDrops), [GF_ID])
    expect(view.instructions[0].primary_message).toBe('Boil the rotini pasta.')
  })
  test('null index returns the base doc unchanged (same reference)', () => {
    expect(restrictedDocView(baseDoc, null, [])).toBe(baseDoc)
    expect(restrictedDocView(baseDoc, buildLadderIndex(), [])).toBe(baseDoc)
  })
  test('no swaps loaded yet = identity (pre-load)', () => {
    const view = restrictedDocView(baseDoc, buildLadderIndex(), [GF_ID])
    expect(view.line_items.map((l) => l.ingredient_name)).toEqual([
      'rotini pasta', 'soy sauce', 'broccoli',
    ])
  })
  test('drops hide lines from display only (no swap, no key change)', () => {
    const dfDoc = {
      ...baseDoc,
      line_items: [
        { id: 11, quantity: '1 ½ (113 g) pkgs', ingredient_name: 'crumbled feta cheese' },
        { id: 12, quantity: '2 tbsp', ingredient_name: 'broccoli' },
      ],
    }
    const view = restrictedDocView(dfDoc, indexWithSwaps(sampleSwaps, sampleDrops), [DF_ID])
    expect(view.line_items.map((l) => l.ingredient_name)).toEqual(['broccoli'])
  })
  test('drops and swaps coexist — swap wins over drop for same from-ingredient', () => {
    const dfDoc = {
      ...baseDoc,
      line_items: [
        { id: 11, quantity: '2 tbsp', ingredient_name: 'butter, unsalted' },
        { id: 12, quantity: '1 ½ (113 g) pkgs', ingredient_name: 'crumbled feta cheese' },
      ],
    }
    const view = restrictedDocView(dfDoc, indexWithSwaps(sampleSwaps, sampleDrops), [DF_ID])
    expect(view.line_items.map((l) => l.ingredient_name)).toContain('virgin coconut oil')
    expect(view.line_items.map((l) => l.ingredient_name)).not.toContain('crumbled feta cheese')
  })
})

/* ---------- groceryDisplayLines (ladder) ---------- */

describe('groceryDisplayLines (ladder)', () => {
  const baseDoc = {
    id: 40001,
    recipe_id: 400,
    serving_count: 6,
    cooking_minutes: 20,
    name: 'Test Bowl',
    slug: 'test-bowl',
    units: 'Metric',
    thumbnail_image_url: '',
    presentation_image_url: '',
    cookwares: [],
    instructions: [],
    line_items: [
      { id: 11, quantity: '15 oz', ingredient_name: 'rotini pasta' },
      { id: 12, quantity: '2 tbsp', ingredient_name: 'soy sauce' },
      { id: 13, quantity: '300 g', ingredient_name: 'broccoli' },
    ],
    nutrition: { energy: 0, carbs: 0, fiber: 0, sugars: 0, fat: 0, protein: 0, sodium: 0 },
  }

  test('the swap case: the substitute name on the base line, base quantity, base key', () => {
    const rows = groceryDisplayLines(baseDoc, indexWithSwaps(sampleSwaps, sampleDrops), [GF_ID])
    expect(rows).toEqual([
      expect.objectContaining({ keyName: 'rotini pasta', name: 'gluten free rotini pasta', quantity: '15 oz' }),
      expect.objectContaining({ keyName: 'soy sauce', name: 'tamari soy sauce', quantity: '2 tbsp' }),
      expect.objectContaining({ keyName: 'broccoli', name: 'broccoli', quantity: '300 g' }),
    ])
  })
  test('drops remove lines from display only (key/checked state untouched)', () => {
    const dfDoc = {
      ...baseDoc,
      line_items: [
        { id: 11, quantity: '1 ½ (113 g) pkgs', ingredient_name: 'crumbled feta cheese' },
        { id: 12, quantity: '2 tbsp', ingredient_name: 'broccoli' },
      ],
    }
    const rows = groceryDisplayLines(dfDoc, indexWithSwaps(sampleSwaps, sampleDrops), [DF_ID])
    expect(rows).not.toBeNull()
    expect(rows!.map((r) => r.name)).not.toContain('crumbled feta cheese')
    expect(rows!.map((r) => r.name)).toContain('broccoli')
  })
  test('null index returns null (pre-load: base doc renders as-is)', () => {
    expect(groceryDisplayLines(baseDoc, null, [])).toBeNull()
    expect(groceryDisplayLines(baseDoc, buildLadderIndex(), [])).toBeNull()
  })
  test('no swaps loaded yet = null (pre-load)', () => {
    expect(groceryDisplayLines(baseDoc, buildLadderIndex(), [GF_ID])).toBeNull()
  })
})

/* ---------- loadRestrictionDict compatibility ---------- */

describe('loadIndex (ladder)', () => {
  test('loads index.json via injected fetch (cold start: nothing beyond index)', async () => {
    const { loadIndex } = await import('./restrictions')
    const baseUrl = '/base/'
    const fetchImpl = async (url: string) => {
      const fs = require('fs')
      const path = require('path')
      const relativePath = url.replace(baseUrl, '')
      const fullPath = path.resolve(process.cwd(), 'public', relativePath)
      if (!fs.existsSync(fullPath)) {
        return new Response('not found', { status: 404 })
      }
      const data = fs.readFileSync(fullPath, 'utf-8')
      return new Response(data, { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const idx = await loadIndex(fetchImpl, baseUrl)
    expect(idx).not.toBeNull()
    const loaded = idx as import('./restrictions').LadderIndex
    expect(loaded.restrictions).toHaveLength(12)
    // Cold start: swaps, drops, removed, pairs are NOT loaded — only index.json
    expect(loaded.swaps).toBeNull()
    expect(loaded.drops).toBeNull()
    expect(loaded.removed.size).toBe(0)
    expect(loaded.pairs.size).toBe(0)
  })
  test('failed index fetch resolves null', async () => {
    const { loadIndex } = await import('./restrictions')
    const idx = await loadIndex(async () => new Response('nope', { status: 404 }), '/')
    expect(idx).toBeNull()
  })
})
