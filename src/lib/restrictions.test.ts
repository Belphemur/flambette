import { describe, expect, test } from 'bun:test'
import {
  RESTRICTIONS,
  buildRestrictionIndex,
  createOverlayLoader,
  groceryDisplayLines,
  isRemovedByRestriction,
  normalizeRestrictionIds,
  overlayDocFor,
  restrictedDocView,
  type RestrictionSetsFile,
  type RecipeDoc,
} from './restrictions'
import { nameKey } from './grocery'
import gfOverlay from '../../public/data/restriction_overlays/gluten-free.json'

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

describe('groceryDisplayLines (key/display split)', () => {
  const overlay = {
    line_items: [
      { quantity: '15 oz', ingredient_name: 'gluten-free rotini pasta' },
      { quantity: '2 tbsp', ingredient_name: 'tamari soy sauce' },
      { quantity: '300 g', ingredient_name: 'broccoli' },
    ],
    instructions: [],
  }
  test('the safe positional case: the overlay name on the base line, base quantity', () => {
    expect(groceryDisplayLines(baseDoc, overlay)).toEqual([
      { keyName: 'rotini pasta', name: 'gluten-free rotini pasta', quantity: '15 oz', keyIngredient: 'rotini pasta' },
      { keyName: 'soy sauce', name: 'tamari soy sauce', quantity: '2 tbsp', keyIngredient: 'soy sauce' },
      { keyName: 'broccoli', name: 'broccoli', quantity: '300 g', keyIngredient: 'broccoli' },
    ])
  })
  test('an unchanged doc yields null (no override)', () => {
    const same = { line_items: baseDoc.line_items.map((l) => ({ quantity: l.quantity, ingredient_name: l.ingredient_name })), instructions: [] }
    expect(groceryDisplayLines(baseDoc, same)).toBeNull()
  })
  test('equal counts but UNEQUAL quantities are the mismatch class — no positional override', () => {
    // GF rid 224's reorder: base lines 2/3 are pasta/garlic, the overlay's
    // are garlic/pasta. Pairing names by position alone once displayed
    // `6 cloves gluten-free fettuccine pasta` — a pair in NEITHER doc.
    const reordered = {
      line_items: [
        { quantity: '15 oz', ingredient_name: 'gluten-free rotini pasta' },
        { quantity: '2 tbsp', ingredient_name: 'tamari soy sauce' },
        { quantity: '300 g', ingredient_name: 'broccoli' },
      ],
      instructions: [],
    }
    const swappedBase: RecipeDoc = {
      ...baseDoc,
      line_items: [
        baseDoc.line_items[0],
        { id: 13, quantity: '300 g', ingredient_name: 'broccoli' },
        { id: 12, quantity: '2 tbsp', ingredient_name: 'soy sauce' },
      ],
    }
    const rows = groceryDisplayLines(swappedBase, reordered)!
    // Every row's (name, quantity) pair co-occurs in the OVERLAY doc.
    expect(rows.map((r) => `${r.quantity} ${r.name}`)).toEqual(
      reordered.line_items.map((li) => `${li.quantity} ${li.ingredient_name}`),
    )
    // Keys follow the base ingredient each row BELONGS to (nameKey match
    // first): the pasta row keys 'rotini pasta', the substituted soy row
    // pairs the leftover base line positionally ('soy sauce'), and the
    // broccoli row keys 'broccoli' wherever it moved.
    expect(rows.map((r) => r.keyName)).toEqual(['rotini pasta', 'soy sauce', 'broccoli'])
  })
  test('a count-changing rework displays the overlay list; keys stay base where a counterpart exists', () => {
    // Collapse: two base lines merged into one overlay line (GF rid 863's
    // class). The unpaired base line is NOT appended — the restricted doc
    // is the display truth, and an ingredient upstream removed from the
    // restricted render must not reappear in the grocery (measured live:
    // GF rid 863's base soy sauce used to survive its own restriction).
    const collapsed = {
      line_items: [
        { quantity: '15 oz', ingredient_name: 'gluten-free rotini pasta' },
        { quantity: '3 tbsp', ingredient_name: 'tamari soy sauce' },
      ],
      instructions: [],
    }
    const rows = groceryDisplayLines(baseDoc, collapsed)!
    expect(rows).toEqual([
      // rotini pairs the leftover base line via nameKey containment (its
      // substituted name embeds the original)…
      { keyName: 'rotini pasta', name: 'gluten-free rotini pasta', quantity: '15 oz', keyIngredient: 'rotini pasta' },
      // …so does the tamari line (keyName from the base 'soy sauce' line,
      // and the re-authored amount keys the base spelling)…
      { keyName: 'soy sauce', name: 'tamari soy sauce', quantity: '3 tbsp', keyQuantity: '2 tbsp', keyIngredient: 'soy sauce' },
      // …and broccoli has no overlay counterpart: dropped, exactly as the
      // restricted doc displays the recipe.
    ])
  })
  test('a rename on a DUPLICATED quantity never pairs positionally (kody: dup-qty reorder)', () => {
    // Two base lines share the empty quantity; a rename on one of them
    // must fall to the nameKey-first pairing instead of trusting position.
    const dupQtyBase: RecipeDoc = {
      ...baseDoc,
      line_items: [
        baseDoc.line_items[0],
        baseDoc.line_items[1],
        baseDoc.line_items[2],
        { id: 14, quantity: '', ingredient_name: 'black pepper' },
        { id: 15, quantity: '', ingredient_name: 'salt' },
      ],
    }
    const renamedDup = {
      line_items: [
        { quantity: '15 oz', ingredient_name: 'gluten-free rotini pasta' },
        { quantity: '2 tbsp', ingredient_name: 'tamari soy sauce' },
        { quantity: '300 g', ingredient_name: 'broccoli' },
        { quantity: '', ingredient_name: 'salt' },
        { quantity: '', ingredient_name: 'black pepper' },
      ],
      instructions: [],
    }
    const rows = groceryDisplayLines(dupQtyBase, renamedDup)!
    // The two swapped empty-quantity seasonings pair by NAME (pass 1),
    // never by position: position is exactly what upstream moved.
    const pepper = rows.find((r) => r.name === 'black pepper')!
    const salt = rows.find((r) => r.name === 'salt')!
    expect(pepper.keyName).toBe('black pepper')
    expect(salt.keyName).toBe('salt')
  })
  test('a split (overlay longer than base): the extra overlay row keys to itself', () => {
    const split = {
      line_items: [
        { quantity: '15 oz', ingredient_name: 'gluten-free rotini pasta' },
        { quantity: '2 tbsp', ingredient_name: 'tamari soy sauce' },
        { quantity: '300 g', ingredient_name: 'broccoli' },
        { quantity: '1 head', ingredient_name: 'butter lettuce' },
      ],
      instructions: [],
    }
    const rows = groceryDisplayLines(baseDoc, split)!
    expect(rows[3]).toEqual({ keyName: 'butter lettuce', name: 'butter lettuce', quantity: '1 head' })
    expect(rows).toHaveLength(4)
  })
  test('keys computed from the base line NEVER see the override', () => {
    // The contract: the grocery group key is nameKey(BASE name); the display
    // name is the overlay's. Line i's key and display stay a pair.
    const rows = groceryDisplayLines(baseDoc, overlay)!
    expect(nameKey(baseDoc.line_items[0].ingredient_name)).toBe(nameKey('rotini pasta'))
    expect(rows[0].name).toBe('gluten-free rotini pasta')
    expect(rows[0].name).not.toBe(baseDoc.line_items[0].ingredient_name)
    expect(rows[0].keyName).toBe(nameKey('rotini pasta'))
  })
})

describe('groceryDisplayLines against the committed GF overlay (the fettuccine regression)', () => {
  // GF rid 224 (Fettuccine Alfredo with Asparagus): upstream's metric rework
  // swaps pasta and garlic lines. The bug shipped `6 cloves gluten-free
  // fettuccine pasta` — base quantity under an overlay name, a pair in
  // NEITHER doc.
  const rid224 = (gfOverlay as { docs: Record<string, { line_items: { quantity: string; ingredient_name: string }[] }> }).docs['224']
  const base224: RecipeDoc = {
    ...baseDoc,
    line_items: [
      { id: 1, quantity: '3 small bunches', ingredient_name: 'asparagus' },
      { id: 2, quantity: '354 ml', ingredient_name: 'chicken or vegetable broth' },
      { id: 3, quantity: '510 g', ingredient_name: 'fettuccine pasta' },
      { id: 4, quantity: '6 cloves', ingredient_name: 'garlic' },
      { id: 5, quantity: '84 g', ingredient_name: 'Parmesan cheese' },
      { id: 6, quantity: '354 ml', ingredient_name: 'whole milk' },
      { id: 7, quantity: '', ingredient_name: 'all-purpose flour' },
      { id: 8, quantity: '', ingredient_name: 'black pepper' },
      { id: 9, quantity: '', ingredient_name: 'butter, unsalted' },
      { id: 10, quantity: '', ingredient_name: 'salt' },
    ],
  }

  test('the overlay itself is metric (no imperial quantity token survives)', () => {
    // The parenthesised container annotation is exempt: upstream authors
    // physical package sizes there even in metric renders — the base metric
    // doc carries `1 ½ (3 oz) pkgs` alfalfa sprouts verbatim.
    const annotation = /\([^)]*\)/g
    for (const doc of Object.values((gfOverlay as { docs: Record<string, { line_items: { quantity: string }[] }> }).docs)) {
      for (const li of doc.line_items) {
        expect(li.quantity.replace(annotation, ' ')).not.toMatch(/\b(?:fl oz|oz|lbs?|pounds?)\b/)
      }
    }
  })

  test('the pasta row shows the substituted name with the METRIC quantity from the same doc', () => {
    const rows = groceryDisplayLines(base224, rid224)!
    const pasta = rows.find((r) => r.name === 'gluten-free fettuccine pasta')!
    expect(pasta).toBeDefined()
    expect(pasta.quantity).toBe('510 g')
    // `6 cloves gluten-free fettuccine pasta` must never reappear.
    expect(rows.some((r) => r.name.includes('fettuccine') && r.quantity === '6 cloves')).toBe(false)
    // The garlic row is garlic, with garlic's own quantity.
    const garlic = rows.find((r) => r.name === 'garlic')!
    expect(garlic.quantity).toBe('6 cloves')
  })

  test('the checked key stays the BASE nameKey', () => {
    const rows = groceryDisplayLines(base224, rid224)!
    const pasta = rows.find((r) => r.name === 'gluten-free fettuccine pasta')!
    expect(pasta.keyName).toBe(nameKey('fettuccine pasta'))
    const garlic = rows.find((r) => r.name === 'garlic')!
    expect(garlic.keyName).toBe(nameKey('garlic'))
  })
})

describe('groceryDisplayLines against the committed GF overlay (rid 863: addition + collapse)', () => {
  // GF rid 863: upstream's gluten-free rework REMOVES the shrimp and fish
  // sauce lines, RENAMES soy sauce to tamari, and ADDS a `12 eggs` line —
  // the pairing regression shipped `1.02 kg` (the shrimp's quantity) as the
  // eggs row's keyQuantity and re-displayed the base `soy sauce` verbatim.
  const rid863 = (gfOverlay as { docs: Record<string, { line_items: { quantity: string; ingredient_name: string }[] }> }).docs['863']
  const base863: RecipeDoc = {
    ...baseDoc,
    line_items: [
      { id: 1, quantity: '1 ½ small bunches', ingredient_name: 'cilantro' },
      { id: 2, quantity: '9 cloves', ingredient_name: 'garlic' },
      { id: 3, quantity: '1 ½ small bunches', ingredient_name: 'green onions (scallions)' },
      { id: 4, quantity: '3', ingredient_name: 'limes' },
      { id: 5, quantity: '0.375 cup', ingredient_name: 'peanuts, roasted unsalted' },
      { id: 6, quantity: '1.02 kg', ingredient_name: 'raw peeled shrimp, fresh or frozen' },
      { id: 7, quantity: '3', ingredient_name: 'shallots' },
      { id: 8, quantity: '3 medium', ingredient_name: 'spaghetti squash' },
      { id: 9, quantity: '', ingredient_name: 'black pepper' },
      { id: 10, quantity: '', ingredient_name: 'cayenne pepper' },
      { id: 11, quantity: '', ingredient_name: 'extra virgin olive oil' },
      { id: 12, quantity: '', ingredient_name: 'fish sauce' },
      { id: 13, quantity: '', ingredient_name: 'pure maple syrup' },
      { id: 14, quantity: '', ingredient_name: 'rice vinegar' },
      { id: 15, quantity: '', ingredient_name: 'salt' },
      { id: 16, quantity: '', ingredient_name: 'soy sauce' },
    ],
  }

  test('the ADDED eggs row keys to itself, never onto a base row', () => {
    const rows = groceryDisplayLines(base863, rid863)!
    const eggs = rows.find((r) => r.name === 'eggs')!
    expect(eggs.keyName).toBe(nameKey('eggs'))
    expect(eggs.keyQuantity).toBeUndefined()
  })

  test('the renamed soy line keeps the base soy-sauce key (containment pairing)', () => {
    const rows = groceryDisplayLines(base863, rid863)!
    const tamari = rows.find((r) => r.name === 'tamari soy sauce')!
    expect(tamari.keyName).toBe(nameKey('soy sauce'))
    // Quantities are both empty — the base spelling IS the display's.
    expect(tamari.keyQuantity).toBeUndefined()
  })

  test('ingredients upstream removed never re-display (the restricted doc is the truth)', () => {
    const rows = groceryDisplayLines(base863, rid863)!
    const names = rows.map((r) => r.name)
    // Exactly the overlay's own 15 lines — no appended base lines.
    expect(rows).toHaveLength(rid863.line_items.length)
    for (const gone of ['raw peeled shrimp, fresh or frozen', 'fish sauce', 'soy sauce']) {
      expect(names).not.toContain(gone)
    }
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
