import { describe, expect, test } from 'bun:test'
import {
  matchMealimeFavourites,
  normalizeMealimeName,
  parseMealimePayload,
} from './mealimeImport'

const CATALOG = [
  { id: 4914, name: 'Grape Tomato, Basil & Ricotta Flatbread Pizza', recipe_id: 121 },
  { id: 6866, name: 'Panko Crusted Tilapia with Lemon Parmesan Asparagus', recipe_id: 779 },
  { id: 5377, name: 'Spicy Orange Tofu & Broccoli with Basmati Rice', recipe_id: 182 },
  // Two variants sharing a normalized name — ambiguity refuses the match.
  { id: 10, name: 'Veggie Bowl', recipe_id: 900 },
  { id: 11, name: 'veggie  bowl!', recipe_id: 901 },
]

function payload(rows: unknown, source = 'flambette-bookmarklet'): string {
  return JSON.stringify({ source, generatedAt: '2026-10-06T00:00:00Z', favourites: rows })
}

describe('parseMealimePayload', () => {
  test('accepts the bookmarklet shape and returns clean rows', () => {
    const result = parseMealimePayload(
      payload([
        { recipe_id: 121, name: 'Flatbread Pizza', image_url: 'https://x/y.jpg' },
        { recipe_id: 779, name: 'Tilapia', extra: 'ignored' },
      ]),
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.favourites).toEqual([
        { recipe_id: 121, name: 'Flatbread Pizza' },
        { recipe_id: 779, name: 'Tilapia' },
      ])
    }
  })

  test('tolerates a missing source (defensive shape)', () => {
    const result = parseMealimePayload(JSON.stringify({ favourites: [{ recipe_id: 121 }] }))
    expect(result.ok).toBe(true)
  })

  test('rejects a payload declaring a different source', () => {
    const result = parseMealimePayload(payload([{ recipe_id: 121 }], 'someone-else'))
    expect(result).toEqual({
      ok: false,
      error: 'unknown payload source "someone-else"',
    })
  })

  test('rejects non-JSON with a precise error', () => {
    expect(parseMealimePayload('not json {')).toEqual({
      ok: false,
      error: 'the pasted text is not valid JSON',
    })
  })

  test('rejects arrays, bare strings and objects without favourites', () => {
    expect(parseMealimePayload('[1,2]').ok).toBe(false)
    expect(parseMealimePayload('"hi"').ok).toBe(false)
    expect(parseMealimePayload('{"source":"flambette-bookmarklet"}').ok).toBe(false)
    expect(parseMealimePayload('{"favourites":"nope"}').ok).toBe(false)
  })

  test('rejects a payload whose favourites resolve to nothing usable', () => {
    expect(parseMealimePayload(payload([])).ok).toBe(false)
    expect(parseMealimePayload(payload([{ foo: 1 }, 'junk', null])).ok).toBe(false)
  })

  test('rejects a payload with ANY malformed row — nothing is silently dropped', () => {
    const result = parseMealimePayload(
      payload([{ recipe_id: 121 }, 'junk', { recipe_id: 'no', name: '' }, { name: 'Tilapia' }]),
    )
    expect(result).toEqual({
      ok: false,
      error: '2 of the payload\'s 4 favourite rows are malformed',
    })
  })
})

describe('matchMealimeFavourites', () => {
  test('matches by recipe_id first', () => {
    const result = matchMealimeFavourites(
      [{ recipe_id: 779, name: 'wrong name that would not match' }],
      CATALOG,
    )
    expect(result.matched).toEqual([{ variantId: 6866, by: 'id' }])
    expect(result.missing).toEqual([])
  })

  test('falls back to normalized name when the id misses', () => {
    const result = matchMealimeFavourites(
      [{ recipe_id: 999_999, name: 'Panko  Crusted Tilapia (with Lemon, Parmesan Asparagus!)' }],
      CATALOG,
    )
    expect(result.matched).toEqual([{ variantId: 6866, by: 'name' }])
  })

  test('reports rows that hit neither bridge as missing', () => {
    const result = matchMealimeFavourites(
      [{ recipe_id: 999_999, name: 'Retired Left-the-catalog Dish' }],
      CATALOG,
    )
    expect(result.matched).toEqual([])
    expect(result.missing).toEqual([{ recipe_id: 999_999, name: 'Retired Left-the-catalog Dish' }])
  })

  test('never guesses on an ambiguous normalized name', () => {
    const result = matchMealimeFavourites([{ name: 'veggie bowl' }], CATALOG)
    expect(result.matched).toEqual([])
    expect(result.missing).toEqual([{ name: 'veggie bowl' }])
  })

  test('dedupes by variantId, first occurrence wins', () => {
    const result = matchMealimeFavourites(
      [
        { recipe_id: 121, name: 'a' },
        { recipe_id: 121, name: 'b' },
        { name: 'grape tomato basil ricotta flatbread pizza' },
      ],
      CATALOG,
    )
    expect(result.matched).toEqual([{ variantId: 4914, by: 'id' }])
    expect(result.duplicatesDropped).toBe(2)
  })

  test('an ambiguous-name row followed by an id hit on one of them still matches', () => {
    // Ambiguity only refuses the NAME bridge; the id bridge stays exact.
    const result = matchMealimeFavourites([{ recipe_id: 901 }], CATALOG)
    expect(result.matched).toEqual([{ variantId: 11, by: 'id' }])
  })

  test('normalizeMealimeName strips punctuation, case and whitespace', () => {
    expect(normalizeMealimeName("Panko-Crusted Tilapia (w/ Lemon)")).toBe(
      'pankocrustedtilapiawlemon',
    )
  })
})
