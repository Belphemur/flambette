import { describe, expect, test } from 'bun:test'
import { ratingFillDimmed } from '../stores/rating'

/**
 * ADR-0082 addendum — the dimmed catalog fill: the star strip's clipped
 * fill overlay carries `opacity-45` ONLY while the displayed value comes
 * from the catalog fallback (household `mine === 0`, a catalog mean
 * actually fills the stars) and nothing is hovered/focused. The ONE
 * predicate lives in stores/rating.ts beside `displayRating`; this pins
 * every flip.
 */
describe('ratingFillDimmed (ADR-0082 addendum)', () => {
  test('dims when the household has not rated and the catalog mean fills', () => {
    // Variant 5377-style: unrated household, catalog Bayesian mean present.
    expect(ratingFillDimmed(0, 0.78, false)).toBe(true)
  })

  test('a committed household rating renders FULL strength', () => {
    expect(ratingFillDimmed(4, 0.78, false)).toBe(false)
    expect(ratingFillDimmed(3.5, 0.78, false)).toBe(false)
    expect(ratingFillDimmed(0.5, 0.78, false)).toBe(false)
  })

  test('hover/focus preview renders FULL strength', () => {
    expect(ratingFillDimmed(0, 0.78, true)).toBe(false)
  })

  test('no catalog score means no fill to dim (the no-score corner)', () => {
    expect(ratingFillDimmed(0, 0, false)).toBe(false)
  })
})