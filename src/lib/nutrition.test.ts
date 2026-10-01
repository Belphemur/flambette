import { describe, expect, test } from 'bun:test'
import {
  ENERGY_ROW,
  NUTRITION_KEYS,
  NUTRITION_GROUPS,
  formatNutritionValue,
  macroSplit,
  nutritionGroups,
  unitFor,
} from './nutrition'
import type { Nutrition } from './types'

/**
 * ADR-0039. The split is a DERIVATION with an honesty gate, so the
 * assertions are about invariants (sums to one, refuses what it cannot
 * derive) and never about a hardcoded catalog percentage — the catalog is
 * frozen but the arithmetic must not be pinned to one recipe's rounding.
 */

/** A plausible, internally consistent per-serving block. */
function balanced(over: Partial<Nutrition> = {}): Nutrition {
  const base: Nutrition = {
    energy: 697.1,
    carbs: 89.04,
    fiber: 0,
    sugars: 0,
    fat: 29.58,
    protein: 21.46,
    sodium: 0,
  }
  return { ...base, ...over }
}

describe('macroSplit', () => {
  test('a coherent triple returns three fractions that sum to one', () => {
    const split = macroSplit(balanced())!
    expect(split).not.toBeNull()
    const sum = split.fatPct + split.carbPct + split.proteinPct
    expect(sum).toBeCloseTo(1, 10)
    for (const part of [split.fatPct, split.carbPct, split.proteinPct]) {
      expect(part).toBeGreaterThanOrEqual(0)
      expect(part).toBeLessThanOrEqual(1)
    }
  })

  test('fat carries the Atwater factors, so it moves less than its grams share', () => {
    const split = macroSplit(balanced())!
    // 9 kcal/g for fat vs 4 for carbs: at equal grams, fat must own more
    // of the energy than the gram fractions alone would suggest.
    const grams = 29.58 + 89.04 + 21.46
    expect(split.fatPct).toBeGreaterThan(29.58 / grams)
    expect(split.proteinPct).toBeLessThan(21.46 / grams)
  })

  test('a proportionally scaled recipe keeps the same split (facts are ratios)', () => {
    const one = macroSplit(balanced())!
    const two = macroSplit(balanced({ energy: 1394.2, fat: 59.16, carbs: 178.08, protein: 42.92 }))!
    expect(two.fatPct).toBeCloseTo(one.fatPct, 6)
    expect(two.carbPct).toBeCloseTo(one.carbPct, 6)
    expect(two.proteinPct).toBeCloseTo(one.proteinPct, 6)
  })

  test('no energy, no split', () => {
    expect(macroSplit(balanced({ energy: 0 }))).toBeNull()
    expect(macroSplit(balanced({ energy: -10 }))).toBeNull()
    expect(macroSplit(null)).toBeNull()
    expect(macroSplit(undefined)).toBeNull()
  })

  test('a triple that cannot account for the energy is REFUSED, not rescaled', () => {
    // Macros worth ~10% of the stated energy: displaying them as 100%
    // would be a fabricated split, so the modal falls back to calories.
    expect(macroSplit(balanced({ energy: 6971, fat: 29.58, carbs: 89.04, protein: 21.46 }))).toBeNull()
    // …and a missing triple is no triple.
    expect(macroSplit(balanced({ fat: 0, carbs: 0, protein: 0 }))).toBeNull()
  })

  test('a negative macro is a data fault and is refused', () => {
    expect(macroSplit(balanced({ fat: -1 }))).toBeNull()
  })

  test('small rounding drift inside the tolerance is normalised, not refused', () => {
    // 98% accounted for: within the ±5% band, so it is normalised to 100.
    const split = macroSplit(balanced({ energy: 711.3 }))!
    expect(split.fatPct + split.carbPct + split.proteinPct).toBeCloseTo(1, 10)
  })

  test('zero-fat and zero-carb recipes keep two honest arcs', () => {
    const noFat = macroSplit(balanced({ energy: 0 + 4 * 89.04 + 4 * 21.46, fat: 0 }))!
    expect(noFat.fatPct).toBe(0)
    expect(noFat.carbPct + noFat.proteinPct).toBeCloseTo(1, 10)
    const noCarb = macroSplit(balanced({ energy: 9 * 29.58 + 4 * 21.46, carbs: 0 }))!
    expect(noCarb.carbPct).toBe(0)
  })
})

describe('the nutrition group layout', () => {
  test('every group is named, and the labels are never raw keys', () => {
    for (const group of NUTRITION_GROUPS) {
      expect(group.title.length).toBeGreaterThan(0)
      expect(group.id.length).toBeGreaterThan(0)
      for (const spec of group.specs) expect(spec.label).not.toBe(spec.key)
    }
  })

  test('the layout covers the catalog keys exactly once', () => {
    expect(new Set(NUTRITION_KEYS).size).toBe(NUTRITION_KEYS.length)
    // Energy is the headline row ABOVE the donut, not a group member.
    expect(ENERGY_ROW.key).toBe('energy')
    expect(NUTRITION_KEYS).not.toContain('energy')
    for (const key of [
      'carbs',
      'fiber',
      'sugars',
      'fat',
      'saturated',
      'cholesterol',
      'protein',
      'alanine',
      'vitamin_a',
      'folate',
      'calcium',
      'sodium',
      'water',
      'caffeine',
      'alcohol',
    ]) {
      expect(NUTRITION_KEYS).toContain(key)
    }
  })

  test('units: kcal for energy, mg for sodium/cholesterol, µg for the fat-soluble set', () => {
    expect(unitFor('energy')).toBe('kcal')
    expect(unitFor('sodium')).toBe('mg')
    expect(unitFor('cholesterol')).toBe('mg')
    for (const key of ['vitamin_a', 'vitamin_d', 'vitamin_k', 'b12_cobalamin', 'folate']) {
      expect(unitFor(key)).toBe('µg')
    }
    expect(unitFor('fat')).toBe('g')
  })

  test('amino acids and the Other remainder are collapsed; the macros are not', () => {
    const byId = new Map(NUTRITION_GROUPS.map((g) => [g.id, g.collapsedByDefault]))
    expect(byId.get('amino-acids')).toBe(true)
    expect(byId.get('other')).toBe(true)
    expect(byId.get('sugars')).toBe(true)
    for (const id of ['carbohydrates', 'fat', 'protein', 'vitamins', 'minerals']) {
      expect(byId.get(id)).toBe(false)
    }
  })

  test('projecting a doc drops absent keys and never invents one', () => {
    const groups = nutritionGroups(balanced())
    const keys = groups.flatMap((g) => g.rows.map((r) => r.key))
    expect(keys).toContain('carbs')
    expect(keys).toContain('fat')
    expect(keys).toContain('protein')
    expect(keys).not.toContain('vitamin_d')
    expect(nutritionGroups(null)).toEqual([])
  })
})

describe('display rounding', () => {
  test('a trace amount keeps one decimal; anything larger is a whole unit', () => {
    expect(formatNutritionValue(0.94, 'g')).toBe('0.9')
    expect(formatNutritionValue(29.58, 'g')).toBe('30')
    expect(formatNutritionValue(0, 'g')).toBe('0')
    expect(formatNutritionValue(697.1, 'kcal')).toBe('697')
  })
})
