import { describe, expect, test } from 'bun:test'
import { ratingFillDimmed, ratingNoScoreCorner } from '../stores/rating'

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

/**
 * ADR-0082 addendum — the no-score corner helper line: 11 of 2,759
 * catalog variants carry `rating: 0` / `rating_count: 0` (variant 32736,
 * "Crumbled Orange-Ginger Tofu Rice Bowl"). When the household has not
 * rated AND the catalog mean is 0, the rate card's helper reads "Be the
 * first to rate this recipe"; every other state keeps the generic tap
 * hint.
 */
describe('ratingNoScoreCorner (ADR-0082 addendum)', () => {
  test('fires when neither household nor catalog has a score', () => {
    expect(ratingNoScoreCorner(0, 0)).toBe(true)
  })

  test('a catalog mean keeps the generic tap hint', () => {
    expect(ratingNoScoreCorner(0, 0.78)).toBe(false)
    // The tiny but nonzero catalog means never read as zero.
    expect(ratingNoScoreCorner(0, 0.001)).toBe(false)
  })

  test('a household rating keeps the generic tap hint', () => {
    expect(ratingNoScoreCorner(1, 0)).toBe(false)
    expect(ratingNoScoreCorner(2, 0.78)).toBe(false)
  })
})