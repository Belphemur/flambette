import { describe, expect, test } from 'bun:test'
import {
  compareByMissingCount,
  missingCount,
  pantryKeyOf,
  pantryMatch,
  sharesPantryIngredient,
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
    expect(sharesPantryIngredient(['Yellow Potatoes', 'butter'], pantry)).toBe(true)
  })
})

describe('pantryMatch shape', () => {
  const pantry = new Set(['tomato', 'garlic', 'olive oil', 'feta'])

  test('full shape from real ingredient names', () => {
    // Catalog `ingredient_names` are short phrases; both sides go through
    // the same nameKey rule ("Tomatoes" and "tomato" meet).
    const m = pantryMatch(['Tomatoes', 'garlic', 'olive oil', 'penne'], pantry)
    expect(m).toEqual({ have: 3, total: 4, missing: ['feta'], ready: false })
  })

  test('ready state: nothing missing', () => {
    const m = pantryMatch(['feta', 'tomato', 'garlic', 'olive oil'], pantry)
    expect(m).toEqual({ have: 4, total: 4, missing: [], ready: true })
  })

  test('missing preserves the pantry set insertion order', () => {
    const m = pantryMatch(['tomato'], pantry)
    expect(m.missing).toEqual(['garlic', 'olive oil', 'feta'])
  })

  test('empty pantry = inactive shape', () => {
    expect(pantryMatch(['tomato'], new Set())).toEqual({
      have: 0,
      total: 0,
      missing: [],
      ready: false,
    })
  })

  test('recipe with no overlap', () => {
    const m = pantryMatch(['rice', 'soy sauce'], pantry)
    expect(m).toEqual({ have: 0, total: 4, missing: ['tomato', 'garlic', 'olive oil', 'feta'], ready: false })
  })

  test('recipe ingredient names are matched through nameKey, verbatim names are not', () => {
    const m = pantryMatch(['carrots'], new Set(['carrot']))
    expect(m.have).toBe(1)
    // The recipe says "carrots", the pantry holds the singular key.
    expect(m.missing).toEqual([])
    expect(m.ready).toBe(true)
  })
})

describe('sharesPantryIngredient (the ≥1-overlap filter, ADR-0087 D4)', () => {
  const pantry = new Set(['tomato', 'garlic'])

  test('true on one shared ingredient', () => {
    expect(sharesPantryIngredient(['butter', 'Garlic'], pantry)).toBe(true)
  })

  test('false with no overlap', () => {
    expect(sharesPantryIngredient(['rice', 'soy sauce'], pantry)).toBe(false)
  })

  test('empty pantry matches nothing (feature off)', () => {
    expect(sharesPantryIngredient(['tomato'], new Set())).toBe(false)
  })

  test('empty recipe matches nothing', () => {
    expect(sharesPantryIngredient([], pantry)).toBe(false)
  })
})

describe('missingCount + compareByMissingCount (ranking, ADR-0087 D4)', () => {
  const pantry = new Set(['tomato', 'garlic', 'olive oil'])

  const meta = (id: number, names: string[]): VariantMeta =>
    ({
      id,
      ingredient_names: names,
    }) as unknown as VariantMeta

  const byMissing = compareByMissingCount(pantry)

  test('fewer missing ranks first; ties resolve to 0 (caller composes)', () => {
    const full = meta(1, ['tomato', 'garlic', 'olive oil'])
    const close = meta(2, ['tomato', 'garlic', 'butter'])
    const far = meta(3, ['rice', 'soy sauce', 'tofu'])
    expect(byMissing(full, close)).toBeLessThan(0)
    expect(byMissing(close, far)).toBeLessThan(0)
    // Tie: two recipes with the same missing count — the comparator
    // resolves to 0 and the caller's sort comparator decides.
    const close2 = meta(4, ['garlic', 'olive oil', 'salt'])
    expect(byMissing(close, close2)).toBe(0)
  })

  test('composition: missing asc, then the caller comparator on ties', () => {
    const rating = (a: VariantMeta, b: VariantMeta) => b.rating - a.rating
    const list = [
      meta(1, ['rice']), // 3 missing, rating 0.4
      meta(2, ['tomato', 'garlic', 'olive oil']), // 0 missing, rating 0.8
      meta(3, ['tomato', 'garlic']), // 1 missing, rating 0.9
      meta(4, ['tomato', 'olive oil']), // 1 missing, rating 0.5
    ]
    list.sort((a, b) => byMissing(a, b) || rating(a, b))
    expect(list.map((m) => m.id)).toEqual([2, 3, 4, 1])
  })

  test('missingCount agrees with the shape', () => {
    expect(missingCount(['tomato', 'garlic'], pantry)).toBe(1)
    expect(missingCount([], pantry)).toBe(3)
    expect(missingCount(['tomato', 'garlic', 'olive oil'], pantry)).toBe(0)
  })
})
