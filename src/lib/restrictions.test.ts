import { describe, expect, test } from 'bun:test'
import {
  RESTRICTIONS,
  buildDictIndex,
  groceryDisplayLines,
  isRemovedByRestriction,
  loadRestrictionDict,
  normalizeRestrictionIds,
  restrictedDocView,
  swapName,
  type RestrictionDict,
} from './restrictions'
import { nameKey } from './grocery'

/* ---------- The dictionary (committed artifact) ---------- */

const dict: RestrictionDict = {
  '1': {
    removed: [50, 60, 195, 224, 863],
    pairRemoved: { '1,10': [70] },
    swaps: [
      { from: 'soy sauce', to: 'tamari soy sauce', quantityRule: 'verbatim', count: 283 },
      { from: 'rotini pasta', to: 'gluten free rotini pasta', quantityRule: 'verbatim', count: 43 },
      { from: 'fettuccine pasta', to: 'gluten free fettuccine pasta', quantityRule: 'verbatim', count: 16 },
      { from: 'butter, unsalted', to: 'virgin coconut oil', quantityRule: 'verbatim', count: 5 },
    ],
  },
  '10': {
    removed: [],
    pairRemoved: { '1,10': [70] },
    swaps: [
      { from: 'mayonnaise', to: 'avocado oil mayonnaise', quantityRule: 'verbatim', count: 3 },
    ],
  },
}

const index = buildDictIndex(dict)

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

describe('buildDictIndex', () => {
  test('null/undefined index returns an empty swap map', () => {
    const empty = buildDictIndex(null)
    expect(empty.dict).toBeNull()
    expect(empty.swaps.byNameKey.size).toBe(0)
  })
  test('stores the dict for query-time filtering', () => {
    expect(index.dict).toBe(dict)
  })
  test('swaps indexed by nameKey of `from`', () => {
    expect(index.swaps.byNameKey.get(nameKey('soy sauce'))?.to).toBe('tamari soy sauce')
    expect(index.swaps.byNameKey.get(nameKey('rotini pasta'))?.to).toBe('gluten free rotini pasta')
    expect(index.swaps.byNameKey.get(nameKey('fettuccine pasta'))?.to).toBe('gluten free fettuccine pasta')
    expect(index.swaps.byNameKey.get(nameKey('butter, unsalted'))?.to).toBe('virgin coconut oil')
    expect(index.swaps.byNameKey.has(nameKey('nonexistent'))).toBe(false)
  })
})

describe('isRemovedByRestriction (dict-based)', () => {
  test('a removed id under an active restriction is gone', () => {
    expect(isRemovedByRestriction(50, [1], index)).toBe(true)
    expect(isRemovedByRestriction(50, [], index)).toBe(false)
    expect(isRemovedByRestriction(50, [2], index)).toBe(false)
  })
  test('pairRemoved extras remove when the pair is active', () => {
    // id 70 is in pairRemoved["1,10"] — removed only when BOTH 1 and 10 active
    expect(isRemovedByRestriction(70, [1, 10], index)).toBe(true)
    // Only one of the pair is NOT enough
    expect(isRemovedByRestriction(70, [1], index)).toBe(false)
    expect(isRemovedByRestriction(70, [10], index)).toBe(false)
  })
  test('the union over several active ids removes if ANY does', () => {
    expect(isRemovedByRestriction(60, [1, 10], index)).toBe(true)
    expect(isRemovedByRestriction(80, [1, 10], index)).toBe(false)
  })
  test('unknown ids and absent sets never remove', () => {
    expect(isRemovedByRestriction(50, [7], index)).toBe(false)
  })
  test('an absent dict never removes', () => {
    const empty = buildDictIndex(undefined)
    expect(isRemovedByRestriction(50, [1], empty)).toBe(false)
  })
})

describe('swapName', () => {
  test('returns the substitute when a swap matches the nameKey', () => {
    expect(swapName('soy sauce', index)).toBe('tamari soy sauce')
    expect(swapName('rotini pasta', index)).toBe('gluten free rotini pasta')
    expect(swapName('fettuccine pasta', index)).toBe('gluten free fettuccine pasta')
    expect(swapName('butter, unsalted', index)).toBe('virgin coconut oil')
  })
  test('returns the original when no swap matches', () => {
    expect(swapName('broccoli', index)).toBe('broccoli')
    expect(swapName('garlic', index)).toBe('garlic')
  })
  test('nameKey matching is case-insensitive', () => {
    expect(swapName('SOY SAUCE', index)).toBe('tamari soy sauce')
  })
})

describe('restrictedDocView (dictionary application)', () => {
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
    const view = restrictedDocView(baseDoc, index)
    expect(view.line_items.map((l) => l.ingredient_name)).toEqual([
      'gluten free rotini pasta', 'tamari soy sauce', 'broccoli',
    ])
    // Quantities stay verbatim from the base doc
    expect(view.line_items.map((l) => l.quantity)).toEqual(['15 oz', '2 tbsp', '300 g'])
    // Ids stay the base ids
    expect(view.line_items.map((l) => l.id)).toEqual([11, 12, 13])
  })
  test('recipe prose stays AUTHENTIC — no substitution in instructions', () => {
    const view = restrictedDocView(baseDoc, index)
    expect(view.instructions[0].primary_message).toBe('Boil the rotini pasta.')
  })
  test('null/empty index returns the base doc unchanged (same reference)', () => {
    expect(restrictedDocView(baseDoc, null)).toBe(baseDoc)
    expect(restrictedDocView(baseDoc, buildDictIndex(undefined))).toBe(baseDoc)
  })
  test('index with no swaps returns the base doc unchanged', () => {
    const noSwapIndex = buildDictIndex({ '9': { removed: [], pairRemoved: {}, swaps: [] } })
    expect(restrictedDocView(baseDoc, noSwapIndex)).toBe(baseDoc)
  })
})

describe('groceryDisplayLines (key/display split, dictionary-based)', () => {
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
    const rows = groceryDisplayLines(baseDoc, index)!
    expect(rows).toEqual([
      { keyName: 'rotini pasta', name: 'gluten free rotini pasta', quantity: '15 oz', keyIngredient: 'rotini pasta' },
      { keyName: 'soy sauce', name: 'tamari soy sauce', quantity: '2 tbsp', keyIngredient: 'soy sauce' },
      { keyName: 'broccoli', name: 'broccoli', quantity: '300 g', keyIngredient: 'broccoli' },
    ])
  })
  test('an unchanged doc yields null (no override)', () => {
    const noSwapIndex = buildDictIndex({ '9': { removed: [], pairRemoved: {}, swaps: [] } })
    expect(groceryDisplayLines(baseDoc, noSwapIndex)).toBeNull()
  })
  test('null index yields null', () => {
    expect(groceryDisplayLines(baseDoc, null)).toBeNull()
    expect(groceryDisplayLines(baseDoc, undefined)).toBeNull()
  })
  test('keys computed from the base line NEVER see the override', () => {
    const rows = groceryDisplayLines(baseDoc, index)!
    expect(nameKey(baseDoc.line_items[0].ingredient_name)).toBe('rotini pasta')
    expect(rows[0].name).toBe('gluten free rotini pasta')
    expect(rows[0].keyName).toBe('rotini pasta')
  })
})

describe('loadRestrictionDict (lazy fetch)', () => {
  test('loads the committed dictionary artifact', async () => {
    const baseUrl = '/base/'
    const fetchImpl = async (url: string) => {
      const fs = require('fs')
      const path = require('path')
      const relativePath = url.replace(baseUrl, '')
      // Resolve from the repo root: public/data/restriction_dict.json
      const fullPath = path.resolve(process.cwd(), 'public', relativePath)
      if (!fs.existsSync(fullPath)) {
        return new Response('not found', { status: 404 })
      }
      const data = fs.readFileSync(fullPath, 'utf-8')
      return new Response(data, { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const d = await loadRestrictionDict(fetchImpl, baseUrl)
    expect(d).not.toBeNull()
    const loaded = d as RestrictionDict
    expect(Object.keys(loaded).length).toBeGreaterThanOrEqual(12)
    // GF (id 1) should have soy sauce → tamari soy sauce
    const gf = loaded['1']
    expect(gf).toBeDefined()
    const soySwap = gf?.swaps.find((s) => s.from === 'soy sauce')
    expect(soySwap).toBeDefined()
    expect(soySwap!.to).toBe('tamari soy sauce')
    expect(soySwap!.quantityRule).toBe('verbatim')
  })
  test('a failed fetch resolves null and is retried', async () => {
    let calls = 0
    const fetchImpl = async () => {
      calls += 1
      return new Response('nope', { status: 404 })
    }
    const d = await loadRestrictionDict(fetchImpl, '/')
    expect(d).toBeNull()
    expect(calls).toBe(1)
  })
})
