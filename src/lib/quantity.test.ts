import { describe, expect, test } from 'bun:test'
import { humanizeAmount, humanizeScaledQuantity } from './quantity'

/**
 * ADR-0054's display rule for SCALED quantities: the authored text stays
 * exact; a scaled rendering rounds the way a cook reads it — counts round
 * half-DOWN to whole pieces, mass/volume lose their sub-integer noise from
 * 5 units up, spoons keep the fraction. Pinned here as pure unit tests so
 * the recipe page and the cooking view can never drift apart on it.
 */
describe('humanizeAmount (scaled-quantity display rounding)', () => {
  test('counts round half-down to whole pieces', () => {
    expect(humanizeAmount(2.25, 'large eggs')).toBe('2')
    expect(humanizeAmount(2.5, 'eggs')).toBe('2')
    expect(humanizeAmount(2.75, 'large eggs')).toBe('3')
    expect(humanizeAmount(3, 'large eggs')).toBe('3')
    expect(humanizeAmount(1.5, 'cloves')).toBe('1')
  })

  test('mass/volume lose sub-integer noise from 5 up', () => {
    expect(humanizeAmount(26.25, 'g')).toBe('26')
    expect(humanizeAmount(26.3, 'g')).toBe('26')
    expect(humanizeAmount(37.5, 'g')).toBe('37')
    expect(humanizeAmount(7.5, 'ml')).toBe('7')
    expect(humanizeAmount(375, 'ml')).toBe('375')
    expect(humanizeAmount(90, 'g')).toBe('90')
  })

  test('small mass/volume amounts keep their decimal', () => {
    // Under 5 the fraction is real information: baking powder, spices.
    expect(humanizeAmount(2.3, 'g')).toBe('2.3')
    expect(humanizeAmount(3.5, 'g')).toBe('3.5')
    expect(humanizeAmount(4.9, 'ml')).toBe('4.9')
  })

  test('spoon units keep the fraction', () => {
    expect(humanizeAmount(1.75, 'tsp')).toBe('1.8')
    expect(humanizeAmount(2.5, 'tbsp')).toBe('2.5')
  })
})

describe('humanizeScaledQuantity (the string form)', () => {
  test('routes a scaled string through the same rule, unit preserved', () => {
    expect(humanizeScaledQuantity('2.25 large eggs')).toBe('2 large eggs')
    expect(humanizeScaledQuantity('26.25 g')).toBe('26 g')
    expect(humanizeScaledQuantity('30 ml')).toBe('30 ml')
    expect(humanizeScaledQuantity('2.3 g')).toBe('2.3 g')
  })

  test('an unparseable string passes through verbatim', () => {
    expect(humanizeScaledQuantity('to taste')).toBe('to taste')
    expect(humanizeScaledQuantity('')).toBe('')
  })

  test('whole values are unchanged strings of themselves', () => {
    expect(humanizeScaledQuantity('3 large eggs')).toBe('3 large eggs')
    expect(humanizeScaledQuantity('40 ml')).toBe('40 ml')
    expect(humanizeScaledQuantity('6')).toBe('6')
  })
})
import { describe, expect, test } from 'bun:test'
import {
  formatAmount,
  formatFraction,
  formatMetricAmount,
  parseQuantity,
  scaleMetricAmount,
  scaleQuantity,
} from './quantity'

/**
 * ADR-0054. The goldens below are measured from the upstream profile
 * archive (`/home/balor/workspace/mealime-media/raw_profiles/`): the
 * metric-6 committed catalog scaled ×⅔ / ×⅓ must reproduce what the
 * upstream metric-4 / metric-2 profiles actually author, and the rendered
 * text must use the catalog's own vocabulary (unicode fractions, integer
 * g/ml, 2–3-decimal kg).
 */
describe('formatFraction renders unicode fraction glyphs', () => {
  test('halves, thirds, quarters and the ⅛ ladder', () => {
    expect(formatFraction(0.5)).toBe('½')
    expect(formatFraction(1.5)).toBe('1 ½')
    expect(formatFraction(2.5)).toBe('2 ½')
    expect(formatFraction(0.25)).toBe('¼')
    expect(formatFraction(0.75)).toBe('¾')
    expect(formatFraction(1.25)).toBe('1 ¼')
    expect(formatFraction(1.3333333)).toBe('1 ⅓')
    expect(formatFraction(2.6666667)).toBe('2 ⅔')
    expect(formatFraction(0.125)).toBe('⅛')
    expect(formatFraction(0.375)).toBe('⅜')
    expect(formatFraction(0.625)).toBe('⅝')
    expect(formatFraction(0.875)).toBe('⅞')
    expect(formatFraction(1.125)).toBe('1 ⅛')
  })

  test('integers and off-grid values stay decimal', () => {
    expect(formatFraction(2)).toBe('2')
    expect(formatFraction(2.2)).toBe('2.2')
    // 0.34 is within formatFraction's 0.02 snap tolerance of ⅓ (pre-existing).
    expect(formatFraction(2.34)).toBe('2 ⅓')
    expect(formatFraction(1.05)).toBe('1.1')
  })

  test('an exact fractional sum keeps its fraction', () => {
    expect(formatFraction(3 / 2)).toBe('1 ½')
    expect(formatFraction(7 / 8)).toBe('⅞')
  })
})

describe('scaleMetricAmount — the upstream metric profile scaling model', () => {
  test('g: source-quantized to ½ oz, scaled, rounded to integer grams', () => {
    // 42 g ≈ 1.5 oz → 0.5 oz × 28.3495 = 14.17 → 14 (matches metric-2)
    expect(scaleMetricAmount(42, 1 / 3, 'g')).toBe(14)
    // 85 g = 3 oz → 2 oz → 56.7 → 57
    expect(scaleMetricAmount(85, 2 / 3, 'g')).toBe(57)
    // 113 g ≈ 4 oz (3.986) → 1.333 oz → 37.8 → 38
    expect(scaleMetricAmount(113, 1 / 3, 'g')).toBe(38)
    // 425 g = 15 oz → 10 oz → 283.5 → 283
    expect(scaleMetricAmount(425, 2 / 3, 'g')).toBe(283)
    // 510 g = 18 oz → 6 oz → 170
    expect(scaleMetricAmount(510, 1 / 3, 'g')).toBe(170)
  })

  test('ml: tbsp-clean values divide exactly (the 67.5 → 22.5 family)', () => {
    expect(scaleMetricAmount(67.5, 1 / 3, 'ml')).toBe(22.5)
    expect(scaleMetricAmount(90, 1 / 3, 'ml')).toBe(30)
    expect(scaleMetricAmount(22.5, 2 / 3, 'ml')).toBe(15)
  })

  test('ml: cup-family values quantize through the cup grid', () => {
    // 1420 ml = 6 cups → 2 cups → 473 ml (metric-2 authors 473)
    expect(scaleMetricAmount(1420, 1 / 3, 'ml')).toBe(473)
    // 2129 ml ≈ 9 cups → 6 cups → 1420 ml (metric-4 authors 1420)
    expect(scaleMetricAmount(2129, 2 / 3, 'ml')).toBe(1420)
    // 237 ml ≈ 1 cup → ¾ cup → 177 ml (both profiles author 177)
    expect(scaleMetricAmount(237, 2 / 3, 'ml')).toBe(177)
  })

  test('ml: fl-oz multiples stay on the fl-oz grid, not the cup grid', () => {
    // 354 ml ≈ 12 fl oz (1.5 cups is 2.9 ml away — outside cup tolerance)
    expect(scaleMetricAmount(354, 2 / 3, 'ml')).toBe(236)
    expect(scaleMetricAmount(531, 1 / 3, 'ml')).toBe(177)
    expect(scaleMetricAmount(100, 1 / 3, 'ml')).toBe(33)
  })

  test('kg: exact gram products stay exact, precision follows the source', () => {
    expect(scaleMetricAmount(1.362, 2 / 3, 'kg')).toBe(0.908)
    expect(scaleMetricAmount(1.02, 1 / 3, 'kg')).toBe(0.34)
    expect(scaleMetricAmount(2.04, 1 / 3, 'kg')).toBe(0.68)
    // A 3-decimal source (the ounce-derived stragglers) floors to 3 decimals.
    expect(scaleMetricAmount(0.341, 1 / 3, 'kg')).toBe(0.113)
    // A 2-decimal source rounds to 2.
    expect(scaleMetricAmount(0.68, 1 / 3, 'kg')).toBe(0.23)
  })

  test('counts and spoons: exact products stay, inexact round', () => {
    expect(scaleMetricAmount(6, 2 / 3, '')).toBe(4)
    expect(scaleMetricAmount(3, 1 / 3, 'cloves')).toBe(1)
    expect(scaleMetricAmount(4.5, 1 / 3, 'medium')).toBe(1.5)
    expect(scaleMetricAmount(5, 1 / 3, 'cloves')).toBe(2)
    expect(scaleMetricAmount(3, 2 / 3, 'tbsp')).toBe(2)
    expect(scaleMetricAmount(2, 2 / 3, 'tbsp')).toBe(1)
  })

  test('cups: exact products stay exact (rendered as fractions)', () => {
    expect(scaleMetricAmount(2, 2 / 3, 'cups')).toBeCloseTo(1.3333333, 6)
    expect(scaleMetricAmount(3, 2 / 3, 'cups')).toBe(2)
    expect(scaleMetricAmount(4.5, 1 / 3, 'cups')).toBe(1.5)
  })
})

describe('formatMetricAmount — unit-aware display rendering', () => {
  test('g and ml render as integers (or ½ glyphs)', () => {
    expect(formatMetricAmount(710, 'ml')).toBe('710')
    expect(formatMetricAmount(473, 'ml')).toBe('473')
    expect(formatMetricAmount(22.5, 'ml')).toBe('22 ½')
    expect(formatMetricAmount(57, 'g')).toBe('57')
    expect(formatMetricAmount(14, 'g')).toBe('14')
  })

  test('kg renders 2–3 decimals without trailing zeros', () => {
    expect(formatMetricAmount(0.908, 'kg')).toBe('0.908')
    expect(formatMetricAmount(0.34, 'kg')).toBe('0.34')
    expect(formatMetricAmount(0.3, 'kg')).toBe('0.3')
    expect(formatMetricAmount(0.11, 'kg')).toBe('0.11')
    expect(formatMetricAmount(2, 'kg')).toBe('2')
  })

  test('cups, tbsp and counts render as fraction glyphs', () => {
    expect(formatMetricAmount(1.3333333, 'cups')).toBe('1 ⅓')
    expect(formatMetricAmount(2, 'cups')).toBe('2')
    expect(formatMetricAmount(1.5, 'tbsp')).toBe('1 ½')
    expect(formatMetricAmount(4, '')).toBe('4')
    expect(formatMetricAmount(1.5, 'medium')).toBe('1 ½')
  })
})

describe('scaleQuantity — string-level, unit-aware', () => {
  test('metric volumes/weights scale through the profile model', () => {
    expect(scaleQuantity('2129 ml', 2 / 3)).toBe('1420 ml')
    expect(scaleQuantity('1420 ml', 1 / 3)).toBe('473 ml')
    expect(scaleQuantity('85 g', 2 / 3)).toBe('57 g')
    expect(scaleQuantity('1.362 kg', 2 / 3)).toBe('0.908 kg')
    expect(scaleQuantity('67.5 ml', 1 / 3)).toBe('22 ½ ml')
  })

  test('metric cups stay cups: exact fractions kept, inexact on the ⅛ grid', () => {
    // 2 cups ×⅔ → 1 ⅓ cups (49 exact matches in the archive)
    expect(scaleQuantity('2 cups', 2 / 3)).toBe('1 ⅓ cups')
    // 3 cups ×⅔ → 2 cups
    expect(scaleQuantity('3 cups', 2 / 3)).toBe('2 cups')
    // 1 cup ×⅔ → ⅔ cup (209 archive matches; the rare cup→ml swap is noise)
    expect(scaleQuantity('1 cup', 2 / 3)).toBe('⅔ cup')
    // ⅓ cup ×⅔ → ¼ cup (223 archive matches — the ⅛ grid, not thirds)
    expect(scaleQuantity('⅓ cup', 2 / 3)).toBe('¼ cup')
    // ¼ cup ×⅔ → ⅛ cup
    expect(scaleQuantity('¼ cup', 2 / 3)).toBe('⅛ cup')
  })

  test('container counts quantize to the nearest ½ and singularize at 1', () => {
    expect(scaleQuantity('1 (142 g) pkg', 2 / 3)).toBe('½ (142 g) pkg')
    expect(scaleQuantity('1 ½ (142 g) pkgs', 2 / 3)).toBe('1 (142 g) pkg')
    expect(scaleQuantity('1 ½ small bunches', 2 / 3)).toBe('1 small bunch')
    expect(scaleQuantity('2 (398 ml) cans', 1 / 3)).toBe('½ (398 ml) can')
  })

  test('counts round to the nearest integer and singularize at 1', () => {
    expect(scaleQuantity('6 cloves', 2 / 3)).toBe('4 cloves')
    expect(scaleQuantity('2 cloves', 2 / 3)).toBe('1 clove')
    expect(scaleQuantity('3 cloves', 1 / 3)).toBe('1 clove')
    expect(scaleQuantity('4.5 medium', 1 / 3)).toBe('1 ½ medium')
    expect(scaleQuantity('5 slices', 1 / 3)).toBe('2 slices')
  })

  test('unparseable quantities and factor 1 pass through verbatim', () => {
    expect(scaleQuantity('a pinch', 2 / 3)).toBe('a pinch')
    expect(scaleQuantity('', 2 / 3)).toBe('')
    expect(scaleQuantity('2129 ml', 1)).toBe('2129 ml')
  })
})

describe('parseQuantity/formatAmount unchanged contract', () => {
  test('formatAmount stays the 1-decimal fallback', () => {
    expect(formatAmount(709.66666)).toBe('709.7')
    expect(formatAmount(2)).toBe('2')
    expect(formatAmount(0.5)).toBe('0.5')
  })

  test('parseQuantity still reads glyph and ASCII fractions', () => {
    expect(parseQuantity('2 ½ cm')).toEqual({ amount: 2.5, unit: 'cm' })
    expect(parseQuantity('3/4 cup')).toEqual({ amount: 0.75, unit: 'cup' })
    expect(parseQuantity('2 1/2 cups')).toEqual({ amount: 2.5, unit: 'cups' })
    expect(parseQuantity('½ (142 g) pkg')?.amount).toBe(0.5)
  })
})
