import { describe, expect, test } from 'bun:test'
import { ingredientDetailFrom, loadIngredientDetail } from './ingredientDetail'

/**
 * The ADR-0099 data slice's accessor contracts: the corpus is keyed by
 * the grocery `nameKey`, and a row may carry an image, substitutes,
 * neither or both. Every shape must produce a SAFE empty fallback, never
 * a throw and never invented data — the sheet hides its sections on
 * emptiness (ADR-0100) rather than rendering something fabricated.
 */
describe('ingredientDetailFrom (the pure accessor seam)', () => {
  const entries = {
    'acorn squash': {
      image: 'img/ingredients/squash.webp',
      substitutes: ['butternut squash', 'delicata squash'],
    },
    'sugar snap peas': { image: 'img/ingredients/snow peas.webp' },
    'alfalfa sprout': { substitutes: ['broccoli sprouts', 'sunflower sprouts'] },
    'flour': { substitutes: ['', 'almond flour'] },
  }

  test('missing row → the empty fallback (both sections hide)', () => {
    expect(ingredientDetailFrom(entries, 'cauliflower')).toEqual({})
    expect(ingredientDetailFrom(entries, '')).toEqual({})
  })

  test('image-only row → image + offline src + the TheMealDB credit', () => {
    const detail = ingredientDetailFrom(entries, 'sugar snap peas')
    // `import.meta.env` degrades outside Vite: BASE_URL may read '/'. Whatever
    // it is, the src must carry the artifact's stored path verbatim at the tail.
    expect(detail.image).toBe('img/ingredients/snow peas.webp')
    expect(detail.imageSrc?.endsWith('img/ingredients/snow peas.webp')).toBe(true)
    expect(detail.credit).toBe('Photo: TheMealDB')
    expect(detail.substitutes).toBeUndefined()
  })

  test('substitutes-only row → prose list alone, no credit (no image, no attribution)', () => {
    const detail = ingredientDetailFrom(entries, 'alfalfa sprout')
    expect(detail.substitutes).toEqual(['broccoli sprouts', 'sunflower sprouts'])
    expect(detail.image).toBeUndefined()
    expect(detail.credit).toBeUndefined()
  })

  test('both dimensions on one row', () => {
    const detail = ingredientDetailFrom(entries, 'acorn squash')
    expect(detail.image).toBe('img/ingredients/squash.webp')
    expect(detail.credit).toBe('Photo: TheMealDB')
    expect(detail.substitutes).toEqual(['butternut squash', 'delicata squash'])
  })

  test('empty substitute strings are never let through (repair loop no-op)', () => {
    expect(ingredientDetailFrom(entries, 'flour').substitutes).toEqual(['almond flour'])
  })
})

describe('loadIngredientDetail (the single-flight corpus chunk)', () => {
  test('the committed artifact answers real nameKeys and safe-empties the rest', async () => {
    // A nameKey the corpus provably carries (an image + substitutes row).
    const squash = await loadIngredientDetail('acorn squash')
    expect(squash.image).toBe('img/ingredients/squash.webp')
    expect(squash.credit).toBe('Photo: TheMealDB')
    expect(squash.substitutes?.length).toBeGreaterThan(0)
    // A nameKey outside the 661-entry universe (an invented grocery key).
    expect(await loadIngredientDetail('pink dragonfruit')).toEqual({})
  })
})
