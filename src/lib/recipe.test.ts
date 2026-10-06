import { describe, expect, test } from 'bun:test'
import { isSeasoning, scaleQuantity, scaleSteps } from './recipe'

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


describe('scaleSteps — step-line unit dispatch (kody Rbm0)', () => {
  const doc = {
    serving_count: 6,
    instructions: [{ primary_message: 'Cook', secondary_message: '' }],
  } as unknown as import('./types').RecipeDoc

  function lines(...details: string[]): string[] {
    const d = {
      ...doc,
      instructions: [{ primary_message: 'Cook', secondary_message: details.join('\n') }],
    } as unknown as import('./types').RecipeDoc
    return scaleSteps(d, 2 / 3)[0].details
  }

  test('a named-unit weight line scales through its unit TOKEN, not the line rest', () => {
    // The full rest ('kg ground turkey') matches no unit key and would fall
    // through to the count branch (`1.02 kg ×⅔ → '1'`). The token keeps the
    // kg grammar: 680 g is exact → 0.68.
    expect(lines('1.02 kg ground turkey')).toEqual(['0.68 kg ground turkey'])
  })

  test('a named-unit volume line keeps the ml grammar and the full rest', () => {
    expect(lines('2129 ml chicken or vegetable broth')).toEqual([
      '1420 ml chicken or vegetable broth',
    ])
  })

  test('the render dispatches on the token too — no fraction-glyph fallback for named units', () => {
    // formatMetricAmount(0.68, 'kg ground turkey') would hit the default
    // branch and render a fraction glyph; the token keeps the 2-dp kg form.
    expect(lines('1.02 kg ground turkey')[0]).toMatch(/^0\.68 kg/)
  })
})
