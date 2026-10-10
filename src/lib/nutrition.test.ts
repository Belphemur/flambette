import { describe, expect, test } from 'bun:test'
import {
  ENERGY_ROW,
  KCAL_PER_G,
  NUTRITION_KEYS,
  NUTRITION_GROUPS,
  formatNutritionRow,
  formatNutritionValue,
  macroGrams,
  macroSplit,
  nutritionGroups,
  unitFor,
  unknownUnitKeys,
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

describe('macroGrams (ADR-0077: the detail legend)', () => {
  // The catalog's macros are FRACTIONS of calories, so grams are derived:
  // the render's salmon card (44g protein / 48g carbs / 26g fat at 620
  // kcal) is reproduced exactly by the shared Atwater factors — the
  // formula is public knowledge and the lib is where it lives, never
  // inline in a component.
  test('fraction × kcal ÷ Atwater factor, per macro', () => {
    expect(macroGrams(0.284, 620, 'protein')).toBeCloseTo(620 * 0.284 / KCAL_PER_G.protein)
    expect(macroGrams(0.31, 620, 'carbs')).toBeCloseTo(620 * 0.31 / KCAL_PER_G.carbs)
    expect(macroGrams(0.378, 620, 'fat')).toBeCloseTo(620 * 0.378 / KCAL_PER_G.fat)
  })

  test('a fraction of 1 means the WHOLE serving is that macro', () => {
    // Pure-fat energy: 100 kcal at fraction 1 = 11.1 g — 9 kcal/g.
    expect(macroGrams(1, 100, 'fat')).toBeCloseTo(100 / 9)
    // Pure protein or carbs: 100 kcal at fraction 1 = 25 g — 4 kcal/g.
    expect(macroGrams(1, 100, 'protein')).toBe(25)
    expect(macroGrams(1, 100, 'carbs')).toBe(25)
  })

  test('zero fraction and zero energy derive zero, never NaN', () => {
    expect(macroGrams(0, 620, 'protein')).toBe(0)
    // kcal is the caller's number and is expected > 0 (per-serving truth);
    // a 0 kcal call still returns a finite number, never NaN.
    expect(Number.isNaN(macroGrams(0.5, 0, 'carbs'))).toBe(false)
    expect(macroGrams(0.5, 0, 'carbs')).toBe(0)
  })
})

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
    // 98% accounted for: within the band, so it is normalised to 100.
    const split = macroSplit(balanced({ energy: 711.3 }))!
    expect(split.fatPct + split.carbPct + split.proteinPct).toBeCloseTo(1, 10)
  })

  test('a high-fiber recipe is DERIVED, not refused (fiber costs 2 kcal/g net)', () => {
    // Catalog recipe 9148, per serving. Counting all 74.55 g of carbs at
    // 4 kcal/g overshot the published 701.46 kcal by 6% and the modal
    // showed "split not derivable" for a recipe whose macros DO account
    // for its energy once fiber is charged at its net factor.
    const derived = macroSplit({
      energy: 701.46,
      fat: 40.03,
      carbs: 74.55,
      protein: 21.92,
      fiber: 21.94,
    })
    expect(derived).not.toBeNull()
    const sum = derived!.fatPct + derived!.carbPct + derived!.proteinPct
    expect(sum).toBeCloseTo(1, 10)
    // Fiber is a real share of the carbohydrate mass, so carbs keep the
    // larger arc even after the discount.
    expect(derived!.carbPct).toBeGreaterThan(derived!.proteinPct)
  })

  test('fiber above the carbohydrate total cannot drive the split negative', () => {
    // A corrupt row (fiber > carbs) must clamp to the carbs, not produce a
    // negative arc: fiber charges 2 kcal/g net, so the clamp is what keeps
    // the carbohydrate contribution at 4·carbs − 2·carbs ≥ 0.
    const split = macroSplit(
      balanced({ carbs: 10, fiber: 40, energy: 9 * 29.58 + 4 * 10 - 2 * 10 + 4 * 21.46 }),
    )!
    expect(split.carbPct).toBeGreaterThanOrEqual(0)
    expect(split.carbPct + split.proteinPct + split.fatPct).toBeCloseTo(1, 10)
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

  test('EVERY known key has an explicit unit — the default must never be reached', () => {
    // A partial table silently printed "1048 g potassium" / "44 g
    // selenium"; this is the regression gate for that class of bug.
    expect(unknownUnitKeys()).toEqual([])
    expect(unknownUnitKeys([...NUTRITION_KEYS, ENERGY_ROW.key])).toEqual([])
    for (const key of [
      'vitamin_c',
      'vitamin_e',
      'b1_thiamine',
      'b2_riboflavin',
      'b3_niacin',
      'b5_pantothenic_acid',
      'b6_pyridoxine',
      'choline',
      'calcium',
      'iron',
      'magnesium',
      'manganese',
      'phosphorus',
      'potassium',
      'zinc',
      'copper',
      'selenium',
      'caffeine',
    ]) {
      expect(['mg', 'µg']).toContain(unitFor(key))
    }
  })

  test('a catalog-magnitude row formats in its PUBLISHED unit', () => {
    // Typical per-serving values from the frozen catalog: potassium and
    // calcium are milligrams, selenium and vitamin A micrograms, protein
    // grams. Before the table was completed these printed as
    // "1190 g potassium" / "44 g selenium" / "827 g vitamin A".
    const groups = nutritionGroups({
      energy: 635.97,
      protein: 35.565,
      fat: 32.175,
      carbs: 47.94,
      potassium: 1189.735,
      calcium: 190.255,
      selenium: 43.965,
      vitamin_a: 826.99,
      vitamin_c: 52.67,
    } as Nutrition)
    const row = (key: string) => {
      const found = groups.flatMap((g) => g.rows).find((r) => r.key === key)
      expect(found).toBeDefined()
      return formatNutritionRow(found!)
    }
    expect(row('potassium')).toEqual({ value: '1190', unit: 'mg' })
    expect(row('calcium')).toEqual({ value: '190', unit: 'mg' })
    expect(row('selenium')).toEqual({ value: '44', unit: 'µg' })
    expect(row('vitamin_a')).toEqual({ value: '827', unit: 'µg' })
    expect(row('vitamin_c')).toEqual({ value: '53', unit: 'mg' })
    expect(row('protein')).toEqual({ value: '36', unit: 'g' })
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
