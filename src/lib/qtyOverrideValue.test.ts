import { describe, expect, test } from 'bun:test'
import {
  MAX_QTY_OVERRIDE,
  MIN_QTY_OVERRIDE,
  normalizeQtyOverrideAmount,
  stepQtyOverrideAmount,
} from './qtyOverrideValue'

/**
 * ADR-0100's clamp-once: the override amount normalizes through the
 * shared quantity parser exactly once — at commit — and the result is
 * both the stored value AND the displayed value. The grammar mirrors the
 * grocery aggregation's format stack, so an overridden badge reads like
 * a derived one.
 */
describe('normalizeQtyOverrideAmount', () => {
  test('count units canonicalize through formatMetricAmount (fraction glyphs)', () => {
    expect(normalizeQtyOverrideAmount('3 cups')).toBe('3 cups')
    expect(normalizeQtyOverrideAmount('2 ½ cups')).toBe('2 ½ cups')
    expect(normalizeQtyOverrideAmount('1/3 cup')).toBe('⅓ cup')
    expect(normalizeQtyOverrideAmount('6 cloves')).toBe('6 cloves')
  })

  test('metric units keep the metric display grammar', () => {
    expect(normalizeQtyOverrideAmount('500 ml')).toBe('500 ml')
    expect(normalizeQtyOverrideAmount('67.51 ml')).toBe('67.5 ml')
    expect(normalizeQtyOverrideAmount('450 g')).toBe('450 g')
    expect(normalizeQtyOverrideAmount('400')).toBe('400')
  })

  test('container phrases canonicalize through formatContainerQuantity', () => {
    // The formatter always pluralizes a non-whole container count — the
    // aggregation's own display vocabulary (ADR-0017).
    expect(normalizeQtyOverrideAmount('½ (142 g) pkg')).toBe('½ (142 g) pkgs')
    expect(normalizeQtyOverrideAmount('2 ½ (142 g) pkg')).toBe('2 ½ (142 g) pkgs')
    expect(normalizeQtyOverrideAmount('1.5 small bunch')).toBe('1 ½ small bunches')
    // Annotation preserved verbatim (leading parenthetical grammar).
    expect(normalizeQtyOverrideAmount('1 (400 g) tin')).toBe('1 (400 g) tin')
  })

  test('non-parsers render verbatim prose (never dropped, never invented)', () => {
    expect(normalizeQtyOverrideAmount('  a pinch  ')).toBe('a pinch')
    expect(normalizeQtyOverrideAmount('to taste')).toBe('to taste')
  })

  test('empty input is not a value — the caller treats it as "drop"', () => {
    expect(normalizeQtyOverrideAmount('')).toBe('')
    expect(normalizeQtyOverrideAmount('   ')).toBe('')
  })

  test('the amount is floored and capped (steppers and typing)', () => {
    expect(normalizeQtyOverrideAmount('-2 cups')).toBe('¼ cups')
    expect(normalizeQtyOverrideAmount(`${MAX_QTY_OVERRIDE + 1} cups`)).toBe(
      `${MAX_QTY_OVERRIDE} cups`,
    )
  })
})

describe('stepQtyOverrideAmount', () => {
  test('counts step by 1 and re-canonicalize', () => {
    expect(stepQtyOverrideAmount('3 cups', 1)).toBe('4 cups')
    expect(stepQtyOverrideAmount('3 cups', -1)).toBe('2 cups')
  })

  test('grams/millilitres step by 10', () => {
    expect(stepQtyOverrideAmount('450 g', 1)).toBe('460 g')
    expect(stepQtyOverrideAmount('460 g', -1)).toBe('450 g')
    expect(stepQtyOverrideAmount('500 ml', 1)).toBe('510 ml')
  })

  test('kg steps by 0.1', () => {
    expect(stepQtyOverrideAmount('1.5 kg', 1)).toBe('1.6 kg')
  })

  test('prose with no parseable amount is a no-op (normalized as prose)', () => {
    expect(stepQtyOverrideAmount('to taste', 1)).toBe('to taste')
  })

  test('stepping never goes under the floor', () => {
    expect(stepQtyOverrideAmount('¼ cups', -1)).toBe('¼ cups')
  })

  test('a mixed fractional draft steps numerically (glyph fractions stay in the vocabulary)', () => {
    expect(stepQtyOverrideAmount('1 ½ tsp', 1)).toBe('2 ½ tsp')
  })
})
