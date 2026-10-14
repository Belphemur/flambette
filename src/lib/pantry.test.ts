import { describe, expect, test } from 'bun:test'
import {
  compareByMissingCount,
  missingCount,
  pantryKeyOf,
  pantryMatch,
  sharesPantryIngredient,
  type PantryRecipeInput,
} from './pantry'
import type { VariantMeta } from './types'

/** ADR-0087 Decision 3: pantry identity IS the grocery nameKey rule. */
describe('pantryKeyOf (nameKey identity, ADR-0012)', () => {
  test('normalizes case and English plurals', () => {
    expect(pantryKeyOf('Carrots')).toBe('carrot')
    expect(pantryKeyOf('  POTATOES ')).toBe('potato')
    expect(pantryKeyOf('Bunches')).toBe('bunch')
    expect(pantryKeyOf('olive oil')).toBe('olive oil')
  })

  test('a pantry chip and a recipe ingredient meet at the same key', () => {
    const pantry = new Set([pantryKeyOf('yellow potatoes')])
    expect(sharesPantryIngredient({ name: 'Hash', ingredient_names: ['Yellow Potatoes', 'butter'] }, pantry)).toBe(true)
  })
})

describe('pantryMatch shape', () => {
  const pantry = new Set(['tomato', 'garlic', 'olive oil', 'feta'])

  test('full shape from real ingredient names', () => {
    // Catalog `ingredient_names` are short phrases; both sides go through
    // the same nameKey rule ("Tomatoes" and "tomato" meet).
    const m = pantryMatch(
      { name: 'Shakshuka', ingredient_names: ['Tomatoes', 'garlic', 'olive oil', 'penne'] },
      pantry,
    )
    expect(m).toEqual({ have: 3, total: 4, missing: ['feta'], ready: false })
  })

  test('ready state: nothing missing', () => {
    const m = pantryMatch(
      { name: 'Shakshuka', ingredient_names: ['feta', 'tomato', 'garlic', 'olive oil'] },
      pantry,
    )
    expect(m).toEqual({ have: 4, total: 4, missing: [], ready: true })
  })

  test('missing preserves the pantry set insertion order', () => {
    const m = pantryMatch({ name: 'Soup', ingredient_names: ['tomato'] }, pantry)
    expect(m.missing).toEqual(['garlic', 'olive oil', 'feta'])
  })

  test('empty pantry = inactive shape', () => {
    expect(pantryMatch({ name: 'tomato', ingredient_names: ['tomato'] }, new Set())).toEqual({
      have: 0,
      total: 0,
      missing: [],
      ready: false,
    })
  })

  test('recipe with no overlap', () => {
    const m = pantryMatch({ name: 'Rice bowl', ingredient_names: ['rice', 'soy sauce'] }, pantry)
    expect(m).toEqual({ have: 0, total: 4, missing: ['tomato', 'garlic', 'olive oil', 'feta'], ready: false })
  })

  test('recipe ingredient names are matched through nameKey, verbatim names are not', () => {
    const m = pantryMatch({ name: 'Glazed carrots', ingredient_names: ['carrots'] }, new Set(['carrot']))
    expect(m.have).toBe(1)
    // The recipe says "carrots", the pantry holds the singular key.
    expect(m.missing).toEqual([])
    expect(m.ready).toBe(true)
  })
})

/** ADR-0087 Addendum §1: the recipe NAME is part of the match surface. */
describe('name-surface matching (Addendum §1)', () => {
  // The owner's exact case, from the baked catalog: NO variant lists
  // `cherry tomatoes` in `ingredient_names` (the taxonomy uses grape
  // tomatoes / tomato / diced tomatoes), but the Tuscan variant carries
  // it in the NAME — which is why normal search found it and the pantry
  // filter (pre-addendum) did not.
  const TUSCAN: PantryRecipeInput = {
    name: 'Creamy Tuscan Chicken with Mushrooms, Spinach, & Cherry Tomatoes',
    ingredient_names: ['chicken breasts', 'mushrooms', 'baby spinach', 'grape tomatoes', 'heavy cream'],
  }

  test("the owner's case: 'cherry tomatoes' matches the Tuscan variant", () => {
    const pantry = new Set(['cherry tomato'])
    expect(pantryMatch(TUSCAN, pantry)).toEqual({
      have: 1,
      total: 1,
      missing: [],
      ready: true,
    })
    expect(sharesPantryIngredient(TUSCAN, pantry)).toBe(true)
    expect(missingCount(TUSCAN, pantry)).toBe(0)
  })

  test('the name surface is nameKey-normalized: case and plurals fold', () => {
    // "Cherry-Tomatoes", "CHERRY TOMATOES", hyphenated — all the same key
    // sequence the chip produced ("Cherry Tomatoes" → 'cherry tomato').
    for (const name of [
      'Cherry Tomatoes on Toast',
      'Blistered Cherry-Tomato Tartines',
      'PAN SEARED CHERRY TOMATOES',
    ]) {
      expect(sharesPantryIngredient({ name, ingredient_names: [] }, new Set(['cherry tomato']))).toBe(true)
    }
  })

  test('multi-word keys match contiguously in the name', () => {
    const pantry = new Set(['olive oil'])
    expect(
      sharesPantryIngredient({ name: 'Bruschetta with Olive Oil and Basil', ingredient_names: ['bread'] }, pantry),
    ).toBe(true)
    // Not contiguous ("olive … oil") — no match.
    expect(
      sharesPantryIngredient({ name: 'Olive and Canola Oil Blend', ingredient_names: [] }, pantry),
    ).toBe(false)
  })

  test('a key absent from both surfaces never matches (the non-match pin)', () => {
    // "tomato" key against a name with no tomato word: the singular
    // token must not appear from anything else in the name.
    const pantry = new Set(['tomato'])
    expect(
      sharesPantryIngredient(
        { name: 'Chicken Rice Casserole', ingredient_names: ['chicken', 'rice'] },
        pantry,
      ),
    ).toBe(false)
    // And grape tomatoes in the ingredient LIST do not stand in for a
    // `tomato` chip either — different keys, different words — when the
    // name carries no tomato word at all.
    expect(
      sharesPantryIngredient(
        { name: 'Chicken Rice Casserole', ingredient_names: ['grape tomatoes'] },
        pantry,
      ),
    ).toBe(false)
  })

  test('the name match feeds the badge math: missing names the other keys', () => {
    const pantry = new Set(['cherry tomato', 'feta'])
    const m = pantryMatch(TUSCAN, pantry)
    // grape tomatoes ≠ cherry tomatoes on the key surface, and 'feta'
    // appears on neither surface → genuinely missing, in pantry order.
    expect(m).toEqual({ have: 1, total: 2, missing: ['feta'], ready: false })
  })

  test('the name surface re-ranks: name matches rank by missing count too', () => {
    const pantry = new Set(['cherry tomato', 'olive oil'])
    const meta = (id: number, name: string, names: string[]): VariantMeta =>
      ({ id, name, ingredient_names: names }) as unknown as VariantMeta
    const byMissing = compareByMissingCount(pantry)
    // A recipe whose NAME carries the key beats one that has neither
    // surface — the comparator reads the extended surface, not just
    // ingredient_names.
    const nameMatch = meta(1, 'Tartines with Cherry Tomatoes', ['bread', 'ricotta'])
    const noMatch = meta(2, 'Rice Bowl', ['rice'])
    expect(byMissing(nameMatch, noMatch)).toBeLessThan(0)
  })
})

describe('sharesPantryIngredient (the ≥1-overlap filter, ADR-0087 D4)', () => {
  const pantry = new Set(['tomato', 'garlic'])

  test('true on one shared ingredient', () => {
    expect(sharesPantryIngredient({ name: 'Soup', ingredient_names: ['butter', 'Garlic'] }, pantry)).toBe(true)
  })

  test('false with no overlap', () => {
    expect(sharesPantryIngredient({ name: 'Rice bowl', ingredient_names: ['rice', 'soy sauce'] }, pantry)).toBe(false)
  })

  test('empty pantry matches nothing (feature off)', () => {
    expect(sharesPantryIngredient({ name: 'tomato', ingredient_names: ['tomato'] }, new Set())).toBe(false)
  })

  test('empty recipe matches nothing', () => {
    expect(sharesPantryIngredient({ name: 'Air', ingredient_names: [] }, pantry)).toBe(false)
  })

  test('true on a name-only match (Addendum §1)', () => {
    expect(sharesPantryIngredient({ name: 'Tomato Salad', ingredient_names: ['cucumber'] }, pantry)).toBe(true)
  })
})

describe('missingCount + compareByMissingCount (ranking, ADR-0087 D4)', () => {
  const pantry = new Set(['tomato', 'garlic', 'olive oil'])

  const meta = (id: number, name: string, names: string[]): VariantMeta =>
    ({
      id,
      name,
      ingredient_names: names,
    }) as unknown as VariantMeta

  const byMissing = compareByMissingCount(pantry)

  test('fewer missing ranks first; ties resolve to 0 (caller composes)', () => {
    const full = meta(1, 'Shakshuka', ['tomato', 'garlic', 'olive oil'])
    const close = meta(2, 'Stew', ['tomato', 'garlic', 'butter'])
    const far = meta(3, 'Rice bowl', ['rice', 'soy sauce', 'tofu'])
    expect(byMissing(full, close)).toBeLessThan(0)
    expect(byMissing(close, far)).toBeLessThan(0)
    // Tie: two recipes with the same missing count — the comparator
    // resolves to 0 and the caller's sort comparator decides.
    const close2 = meta(4, 'Dip', ['garlic', 'olive oil', 'salt'])
    expect(byMissing(close, close2)).toBe(0)
  })

  test('composition: missing asc, then the caller comparator on ties', () => {
    const rating = (a: VariantMeta, b: VariantMeta) => b.rating - a.rating
    const list = [
      meta(1, 'Rice bowl', ['rice']), // 3 missing, rating 0.4
      meta(2, 'Shakshuka', ['tomato', 'garlic', 'olive oil']), // 0 missing, rating 0.8
      meta(3, 'Stew', ['tomato', 'garlic']), // 1 missing, rating 0.9
      meta(4, 'Dip', ['tomato', 'olive oil']), // 1 missing, rating 0.5
    ]
    list.sort((a, b) => byMissing(a, b) || rating(a, b))
    expect(list.map((m) => m.id)).toEqual([2, 3, 4, 1])
  })

  test('missingCount agrees with the shape', () => {
    expect(missingCount({ name: 'Stew', ingredient_names: ['tomato', 'garlic'] }, pantry)).toBe(1)
    expect(missingCount({ name: 'Air', ingredient_names: [] }, pantry)).toBe(3)
    expect(
      missingCount({ name: 'Shakshuka', ingredient_names: ['tomato', 'garlic', 'olive oil'] }, pantry),
    ).toBe(0)
  })

  test('ready-state math over the extended surface', () => {
    // Ingredients carry one key, the NAME carries the other two → ready.
    const m = pantryMatch(
      { name: 'Tomato & Garlic Confit in Olive Oil', ingredient_names: ['tomato'] },
      pantry,
    )
    expect(m.ready).toBe(true)
    expect(m.missing).toEqual([])
    // One surface short of a full house → not ready, missing in pantry
    // order.
    const partial = pantryMatch({ name: 'Garlic confit', ingredient_names: ['tomato'] }, pantry)
    expect(partial.ready).toBe(false)
    expect(partial.missing).toEqual(['olive oil'])
  })
})
