import { describe, expect, test } from 'bun:test'
import { isSeasoning, scaleQuantity } from './recipe'

/**
 * ADR-0009's sub-linear seasoning rule, with the ADR-0057 classifier fix:
 * word-boundary matching (unsalted butter is not a seasoning) and
 * compound-name exclusions (ginger root and sesame ginger dressing scale
 * LINEARLY upstream — measured 302/306 exact ×⅓ in the profile archive).
 */
describe('isSeasoning — the ADR-0057 classifier fix', () => {
  test('unsalted never triggers the salt keyword (word boundaries)', () => {
    expect(isSeasoning('butter, unsalted')).toBe(false)
    expect(isSeasoning('unsalted butter')).toBe(false)
    expect(isSeasoning('cashews, roasted unsalted')).toBe(false)
    expect(isSeasoning('peanuts, roasted unsalted')).toBe(false)
    expect(isSeasoning('pistachios, unsalted')).toBe(false)
  })

  test('ginger root is the fresh root, NOT the spice (linear upstream)', () => {
    expect(isSeasoning('ginger root')).toBe(false)
    expect(isSeasoning('ginger root, peeled')).toBe(false)
  })

  test('a compound name describes, it never IS: dressing stays linear', () => {
    expect(isSeasoning('sesame ginger dressing')).toBe(false)
  })

  test('real seasonings still match (coverage unchanged)', () => {
    for (const name of [
      'salt',
      'kosher salt',
      'sea salt',
      'black pepper',
      'red pepper flakes',
      'garlic powder',
      'ground ginger',
      'ground cloves',
      'cayenne',
      'paprika',
      'ground cumin',
      'chili powder',
      'bay leaves',
      'dried thyme',
    ]) {
      expect(isSeasoning(name)).toBe(true)
    }
  })

  test('vegetables and hybrids stay linear', () => {
    expect(isSeasoning('red bell pepper')).toBe(false)
    expect(isSeasoning('green pepper')).toBe(false)
    expect(isSeasoning('garlic')).toBe(false)
    expect(isSeasoning('6 cloves garlic')).toBe(false)
  })
})

describe('scaleQuantity — the sub-linear seasoning rule itself (ADR-0009)', () => {
  test('non-seasonings scale linearly', () => {
    expect(scaleQuantity(100, 6, 12, false)).toBe(200)
    expect(scaleQuantity(85, 6, 2, false)).toBeCloseTo(28.333, 3)
  })

  test('seasonings scale sub-linearly and stay capped', () => {
    // ratio 2: 100 × 2^0.75 = 168.18… (paprika has no named cap; the 2×
    // default does not bite at ratio 2)
    expect(scaleQuantity(100, 6, 12, true, 'paprika')).toBe(168.179)
    // the cap: salt's absolute 4 g ceiling bites long before 2× at 36 servings
    expect(scaleQuantity(3, 6, 36, true, 'salt')).toBe(4)
  })
})
