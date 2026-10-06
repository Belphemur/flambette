import { describe, expect, test } from 'bun:test'
import {
  RESTRICTIONS,
  buildRestrictionIndex,
  createOverlayLoader,
  groceryDisplayNames,
  isRemovedByRestriction,
  normalizeRestrictionIds,
  overlayDocFor,
  restrictedDocView,
  type RestrictionSetsFile,
  type RecipeDoc,
} from './restrictions'
import { nameKey } from './grocery'

const sets: RestrictionSetsFile = {
  generated_at: '2026-10-06T00:00:00Z',
  restrictions: {
    '1': {
      slug: 'gluten-free',
      label: 'Gluten-Free',
      removed: [50, 60, 195],
      overlay: 'restriction_overlays/gluten-free.json',
      swapped_docs: 2,
    },
    '10': {
      slug: 'nightshade-free',
      label: 'Nightshade-Free',
      removed: [70],
      overlay: 'restriction_overlays/nightshade-free.json',
      swapped_docs: 1,
    },
  },
}

const index = buildRestrictionIndex(sets)

const baseDoc: RecipeDoc = {
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

describe('isRemovedByRestriction (O(1) index)', () => {
  test('a removed id under an active restriction is gone', () => {
    expect(isRemovedByRestriction(50, [1], index)).toBe(true)
    expect(isRemovedByRestriction(50, [], index)).toBe(false)
    expect(isRemovedByRestriction(50, [2], index)).toBe(false)
  })
  test('the union over several active ids removes if ANY does', () => {
    expect(isRemovedByRestriction(70, [1, 10], index)).toBe(true)
    expect(isRemovedByRestriction(60, [1, 10], index)).toBe(true)
    expect(isRemovedByRestriction(80, [1, 10], index)).toBe(false)
  })
  test('unknown ids and absent sets never remove', () => {
    expect(isRemovedByRestriction(50, [7], index)).toBe(false)
  })
  test('an empty/absent sets file never removes', () => {
    const empty = buildRestrictionIndex(undefined)
    expect(isRemovedByRestriction(50, [1], empty)).toBe(false)
  })
})

describe('overlayDocFor', () => {
  const overlays = {
    'gluten-free': {
      slug: 'gluten-free',
      docs: { 400: { line_items: [{ quantity: 'a', ingredient_name: 'gf' }], instructions: [] } },
    },
    'nightshade-free': {
      slug: 'nightshade-free',
      docs: { 400: { line_items: [{ quantity: 'b', ingredient_name: 'ns' }], instructions: [] } },
    },
  }
  test('picks the reworked doc for an active slug', () => {
    expect(overlayDocFor(400, [1], overlays)).not.toBeNull()
    expect(overlayDocFor(401, [1], overlays)).toBeNull()
    expect(overlayDocFor(400, [], overlays)).toBeNull()
  })
  test('several active restrictions: the smallest id wins deterministically', () => {
    // both active ids have a rework for 400; ascending order must pick id 1.
    expect(overlayDocFor(400, [10, 1], overlays)!.line_items[0].ingredient_name).toBe('gf')
    expect(overlayDocFor(400, [1, 10], overlays)!.line_items[0].ingredient_name).toBe('gf')
  })
})

describe('restrictedDocView (display truth)', () => {
  const overlay = {
    line_items: [
      { quantity: '15 oz', ingredient_name: 'gluten-free rotini pasta' },
      { quantity: '2 tbsp', ingredient_name: 'tamari soy sauce' },
      { quantity: '300 g', ingredient_name: 'broccoli' },
    ],
    instructions: [{ id: 1, primary_message: 'Boil the gluten-free rotini pasta.', secondary_message: null }],
  }
  test('replaces line_items and instructions wholesale, keeps the rest', () => {
    const view = restrictedDocView(baseDoc, overlay)
    expect(view.line_items.map((l) => l.ingredient_name)).toEqual([
      'gluten-free rotini pasta', 'tamari soy sauce', 'broccoli',
    ])
    expect(view.instructions).toEqual(overlay.instructions)
    expect(view.name).toBe(baseDoc.name)
    expect(view.serving_count).toBe(baseDoc.serving_count)
    expect(view.nutrition).toBe(baseDoc.nutrition)
  })
  test('line ids stay the BASE ids positionally', () => {
    const view = restrictedDocView(baseDoc, overlay)
    expect(view.line_items.map((l) => l.id)).toEqual([11, 12, 13])
  })
  test('a count-changing rework keeps base ids then synthesizes negatives', () => {
    const shorter = { line_items: overlay.line_items.slice(0, 2), instructions: [] }
    const view = restrictedDocView(baseDoc, shorter)
    expect(view.line_items.map((l) => l.id)).toEqual([11, 12])
    const longer = { line_items: [...overlay.line_items, { quantity: '1', ingredient_name: 'x' }], instructions: [] }
    expect(restrictedDocView(baseDoc, longer).line_items.map((l) => l.id)).toEqual([11, 12, 13, -4])
  })
  test('null overlay returns the base doc unchanged (same reference)', () => {
    expect(restrictedDocView(baseDoc, null)).toBe(baseDoc)
  })
})

describe('groceryDisplayNames (key/display split)', () => {
  const overlay = {
    line_items: [
      { quantity: '15 oz', ingredient_name: 'gluten-free rotini pasta' },
      { quantity: '2 tbsp', ingredient_name: 'tamari soy sauce' },
      { quantity: '300 g', ingredient_name: 'broccoli' },
    ],
    instructions: [],
  }
  test('only changed lines are overridden; base names otherwise', () => {
    expect(groceryDisplayNames(baseDoc, overlay)).toEqual([
      'gluten-free rotini pasta', 'tamari soy sauce', 'broccoli',
    ])
  })
  test('an unchanged doc yields null (no override)', () => {
    const same = { line_items: baseDoc.line_items.map((l) => ({ quantity: l.quantity, ingredient_name: l.ingredient_name })), instructions: [] }
    expect(groceryDisplayNames(baseDoc, same)).toBeNull()
  })
  test('a count-changing rework yields null — the base doc stays the grocery truth', () => {
    const shorter = { line_items: overlay.line_items.slice(0, 2), instructions: [] }
    expect(groceryDisplayNames(baseDoc, shorter)).toBeNull()
  })
  test('keys computed from the base line NEVER see the override', () => {
    // The contract: the grocery group key is nameKey(BASE name); the display
    // name is the overlay's. Line i's key and display stay a pair.
    const names = groceryDisplayNames(baseDoc, overlay)!
    expect(nameKey(baseDoc.line_items[0].ingredient_name)).toBe(nameKey('rotini pasta'))
    expect(names[0]).toBe('gluten-free rotini pasta')
    expect(names[0]).not.toBe(baseDoc.line_items[0].ingredient_name)
  })
})

describe('createOverlayLoader', () => {
  test('fetches per slug and caches successes', async () => {
    const urls: string[] = []
    const fetchImpl = (async (url: string) => {
      urls.push(url)
      return new Response(JSON.stringify({ slug: 'gluten-free', docs: {} }), { status: 200 })
    }) as typeof fetch
    const load = createOverlayLoader(fetchImpl, '/base/')
    expect(await load('gluten-free')).toEqual({ slug: 'gluten-free', docs: {} })
    expect(await load('gluten-free')).toEqual({ slug: 'gluten-free', docs: {} })
    expect(urls).toEqual(['/base/data/restriction_overlays/gluten-free.json'])
  })
  test('a failed fetch resolves null and is retried, not cached', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      return new Response('nope', { status: 404 })
    }) as typeof fetch
    const load = createOverlayLoader(fetchImpl, '/')
    expect(await load('dairy-free')).toBeNull()
    expect(await load('dairy-free')).toBeNull()
    expect(calls).toBe(2)
  })
})
