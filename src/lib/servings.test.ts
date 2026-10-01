import { describe, expect, test } from 'bun:test'
import { clampServings, FALLBACK_SERVINGS, isServings, MAX_SERVINGS } from './servings'

/**
 * The remembered default serving size (ADR-0037). The clamp is the only
 * thing standing between a persisted, hand-editable number and every
 * recipe's scale factor, so the interesting cases are all the bad inputs.
 */
describe('clampServings', () => {
  test('an ordinary household count passes through', () => {
    expect(clampServings(4)).toBe(4)
    expect(clampServings(2)).toBe(2)
    expect(clampServings(8)).toBe(8)
  })

  test('a fractional count is rounded, not truncated', () => {
    // A `+` press on a 0.5-stepped UI must not floor to the lower meal.
    expect(clampServings(4.4)).toBe(4)
    expect(clampServings(4.6)).toBe(5)
  })

  test('the authored 6 is the fallback, so an untouched install is unchanged', () => {
    expect(FALLBACK_SERVINGS).toBe(6)
    expect(clampServings(undefined)).toBe(6)
    expect(clampServings(null)).toBe(6)
  })

  test('garbage falls back rather than collapsing the recipe to 1', () => {
    // A stepper at its floor sends 0; storing 1 would silently re-scope
    // every future recipe to a single portion.
    expect(clampServings(0)).toBe(6)
    expect(clampServings(-3)).toBe(6)
    expect(clampServings(NaN)).toBe(6)
    expect(clampServings(Infinity)).toBe(6)
    expect(clampServings('4')).toBe(6)
  })

  test('an absurd value is capped, never stored', () => {
    expect(clampServings(1e9)).toBe(MAX_SERVINGS)
    expect(clampServings(MAX_SERVINGS + 1)).toBe(MAX_SERVINGS)
    // The cap itself is a legal value.
    expect(clampServings(MAX_SERVINGS)).toBe(MAX_SERVINGS)
  })

  test('the fallback is itself overridable and still clamped', () => {
    expect(clampServings(0, 4)).toBe(4)
    expect(clampServings(1000, 4)).toBe(MAX_SERVINGS)
  })
})

/**
 * `isServings` gates the BACKUP validator, which must reject a malformed
 * archive rather than repair it (import is validation-first, ADR-0013).
 * That makes it deliberately stricter than `clampServings`: no rounding,
 * no out-of-range acceptance.
 */
describe('isServings', () => {
  test('accepts a real in-range count', () => {
    expect(isServings(1)).toBe(true)
    expect(isServings(4)).toBe(true)
    expect(isServings(MAX_SERVINGS)).toBe(true)
  })

  test('rejects what the clamp would have silently repaired', () => {
    expect(isServings(0)).toBe(false)
    expect(isServings(-1)).toBe(false)
    expect(isServings(MAX_SERVINGS + 1)).toBe(false)
    expect(isServings(4.5)).toBe(false)
    expect(isServings(NaN)).toBe(false)
    expect(isServings('4')).toBe(false)
    expect(isServings(undefined)).toBe(false)
  })
})
