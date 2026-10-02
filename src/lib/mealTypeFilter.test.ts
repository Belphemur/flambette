import { describe, expect, test } from 'bun:test'
import rawTypes from '../../public/data/recipe_types.json'
import {
  MEAL_TYPE_IDS,
  MEAL_TYPE_OPTIONS,
  OFFERED_MEAL_TYPES,
  matchesMealType,
  mealTypeCount,
  mealTypeLabel,
  normalizeMealType,
  type MealTypeId,
} from './mealTypeFilter'

/**
 * The meal-type facet is EXACT (ADR-0043): the taxonomy and the counts
 * are Mealime's own `ruleset` field, tallied at build time into the
 * committed recipe_types.json. These tests are the client's half of that
 * contract — the Python half is `scripts/test_extract_recipe_types.py`
 * (14 goldens) and `extract_recipe_types.py --check`.
 *
 * The point of pinning the numbers here is that a silent catalog refresh
 * must not quietly change what a filter claims. Breakfast is 151 because
 * that is what the Mealime app itself reports for the same field; if a
 * future sync breaks that, the extractor goldens and this both say so.
 */

const doc = rawTypes as unknown as {
  byId: Record<string, { count: number; offered: boolean; ruleset: string }>
  order: number[]
  total: number
  unmatched: number
}

describe('the committed meal-type table', () => {
  test('every variant is bucketed: no unmatched ruleset, and the counts partition the catalog', () => {
    expect(doc.unmatched).toBe(0)
    const summed = MEAL_TYPE_OPTIONS.reduce((n, o) => n + o.count, 0)
    expect(summed).toBe(doc.total)
  })

  test('the app-facing counts are the catalog fact they claim to be', () => {
    // 151 breakfasts is the number the Mealime app shows for this very
    // field, which is how the taxonomy was identified in the first place.
    expect(mealTypeCount(-1)).toBe(151)
    expect(mealTypeCount(-2)).toBe(91)
    expect(mealTypeCount(-5)).toBe(2119)
    // Dinner is the largest bucket by a wide margin; the branded bucket
    // is a rounding error.
    expect(mealTypeCount(-5)).toBeGreaterThan(mealTypeCount(-4))
    expect(mealTypeCount(-6)).toBeLessThan(10)
  })

  test('the offered list is the five meals, Branded last and never offered', () => {
    expect(OFFERED_MEAL_TYPES.map((o) => o.label)).toEqual([
      'Breakfast',
      'Dessert',
      'Snack',
      // The catalog ruleset is `simple`; we surface it as Lunch (ADR-0043).
      'Lunch',
      'Dinner',
    ])
    expect(OFFERED_MEAL_TYPES.some((o) => o.id === -6)).toBe(false)
    // Display order, not registry order.
    expect(MEAL_TYPE_IDS).toEqual([-1, -2, -3, -4, -5])
  })

  test('ids are negative, so an occasion can never collide with a variant id', () => {
    for (const o of MEAL_TYPE_OPTIONS) expect(o.id).toBeLessThan(0)
  })

  test('each bucket names its own ruleset, and none is shared', () => {
    const rulesets = MEAL_TYPE_OPTIONS.map((o) => o.ruleset)
    expect(new Set(rulesets).size).toBe(rulesets.length)
    expect(MEAL_TYPE_OPTIONS.map((o) => o.ruleset)).toEqual([
      'breakfast',
      'dessert',
      'snack',
      'simple',
      'dinner',
      'cpg',
    ])
  })

  test('every bucket has a bundled icon name and a human label', () => {
    for (const o of MEAL_TYPE_OPTIONS) {
      expect(o.icon).not.toBe('')
      expect(o.label).not.toBe('')
    }
  })
})

describe('matchesMealType', () => {
  test('Any keeps every recipe', () => {
    expect(matchesMealType('dinner', null)).toBe(true)
    expect(matchesMealType('cpg', null)).toBe(true)
    expect(matchesMealType(undefined, null)).toBe(true)
  })

  test('a bucket matches its own ruleset and nothing else — exactly, no lens', () => {
    expect(matchesMealType('dessert', -2)).toBe(true)
    expect(matchesMealType('dinner', -2)).toBe(false)
    expect(matchesMealType('dessert ', -2)).toBe(false) // no trimming, no guessing
    expect(matchesMealType(undefined, -1)).toBe(false)
  })
})

describe('normalizeMealType', () => {
  test('an offered id passes; an unoffered or unknown one means Any', () => {
    expect(normalizeMealType(-5)).toBe<MealTypeId>(-5)
    expect(normalizeMealType(-6)).toBeNull()
    expect(normalizeMealType(12)).toBeNull()
    expect(normalizeMealType('dinner')).toBeNull()
    expect(normalizeMealType(null)).toBeNull()
    expect(normalizeMealType(undefined)).toBeNull()
  })
})

describe('mealTypeLabel', () => {
  test('reads as the bucket, and falls back to Any rather than blank', () => {
    expect(mealTypeLabel(-1)).toBe('Breakfast')
    expect(mealTypeLabel(null)).toBe('Any')
    expect(mealTypeLabel(999 as MealTypeId)).toBe('Any')
  })
})
