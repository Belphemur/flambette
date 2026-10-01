import { beforeEach, describe, expect, test } from 'bun:test'
import { createPinia, setActivePinia } from 'pinia'
import { ratingsToRows, useRatingStore } from './rating'

/**
 * Household rating reconciliation (ADR-0031).
 *
 * The rules under test, with SYNTHETIC timestamps (the store's `updatedAt`
 * seam) so nothing depends on the wall clock or on sleeping:
 * - a record is adopted only when it is strictly newer;
 * - different recipes never touch each other;
 * - a second voice on the same recipe rolls the count forward.
 */
describe('useRatingStore (ADR-0031)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  /** A store on its OWN pinia — i.e. a different device. */
  function peerStore() {
    setActivePinia(createPinia())
    return useRatingStore()
  }

  test('seeds empty — a rating is opinion, never catalog truth', () => {
    expect(useRatingStore().map).toEqual({})
    expect(useRatingStore().ratingFor(17452)).toBe(0)
  })

  test('setRating stamps the write time and keeps the count on a re-rate', () => {
    const store = useRatingStore()
    store.setRating(7, 2, 1_000)
    expect(store.map['7']).toEqual({ rating: 2, count: 1, updatedAt: 1_000 })
    store.setRating(7, 5, 2_000)
    expect(store.map['7']).toEqual({ rating: 5, count: 1, updatedAt: 2_000 })
    // Half steps are the stored grid — no silent rounding.
    store.setRating(7, 3.4, 3_000)
    expect(store.map['7'].rating).toBe(3.5)
  })

  test('a NEWER record wins: peer B (5) beats peer A (4), adopted verbatim', () => {
    const a = useRatingStore()
    a.setRating(100, 4, 1_000) // A rated it 4 at t=1000

    // B is a DIFFERENT device: its own pinia, its own store instance.
    const b = peerStore()
    b.mergeRemote(a.map) // B joins afterwards and adopts A's 4
    expect(b.ratingFor(100)).toBe(4)

    b.setRating(100, 5, 5_000) // B changes its mind, later
    a.mergeRemote(b.map) // A receives B's newer opinion
    expect(a.ratingFor(100)).toBe(5)
    // Adopted VERBATIM, count included: an increment on receive is not
    // idempotent under replay, and would leave peers disagreeing.
    expect(a.countFor(100)).toBe(1)
    // And it converges back the other way: both devices hold B's record.
    b.mergeRemote(a.map)
    expect(b.ratingFor(100)).toBe(5)
    expect(b.countFor(100)).toBe(1)
    expect(a.map['100']).toEqual(b.map['100'])
  })

  test('an OLDER record loses: reversing the timestamps keeps the 4', () => {
    const a = useRatingStore()
    a.setRating(100, 5, 9_000) // the 5 is the OLDER write here
    a.mergeRemote({ '100': { rating: 4, count: 1, updatedAt: 1_000 } })
    expect(a.ratingFor(100)).toBe(5)
    expect(a.map['100'].updatedAt).toBe(9_000)
  })

  test('an equal timestamp is not a new opinion (no count inflation on echo)', () => {
    const store = useRatingStore()
    store.setRating(1, 4, 500)
    store.mergeRemote({ '1': { rating: 2, count: 1, updatedAt: 500 } })
    expect(store.ratingFor(1)).toBe(4)
    expect(store.countFor(1)).toBe(1)
  })

  test('ratings for different recipes never touch each other', () => {
    const store = useRatingStore()
    store.setRating(1, 5, 1_000)
    store.setRating(2, 3, 1_000)
    store.mergeRemote({ '3': { rating: 4, count: 2, updatedAt: 10 } })
    expect(Object.keys(store.map).sort()).toEqual(['1', '2', '3'])
    expect(store.ratingFor(3)).toBe(4)
    expect(store.countFor(3)).toBe(2) // a first-seen record keeps its own count
  })

  test('an untrusted payload is sanitized, not merged blind', () => {
    const store = useRatingStore()
    store.mergeRemote({
      '5': { rating: 42, count: -3, updatedAt: 'later' },
      nope: { rating: 4, count: 1, updatedAt: 1 },
      '6': { rating: 0, count: 1, updatedAt: 1 },
    })
    expect(store.map).toEqual({ '5': { rating: 5, count: 1, updatedAt: 0 } })
  })

  test('an unrated recipe reports count 0 (the star widget relies on it)', () => {
    const store = useRatingStore()
    expect(store.countFor(999)).toBe(0)
    store.setRating(999, 3, 1)
    expect(store.countFor(999)).toBe(1)
  })

  test('a far-future stamp is clamped, so it cannot pin a rating forever', () => {
    const store = useRatingStore()
    const now = Date.now()
    store.setRating(1, 5, now)
    // A peer (or a hand-edited file) claiming a decade from now.
    store.mergeRemote({ '1': { rating: 2, count: 1, updatedAt: now + 10 * 365 * 86_400_000 } })
    // It is stored CLAMPED into the plausible-skew window, not verbatim.
    expect(store.ratingFor(1)).toBe(2) // it still wins near-term
    // Clamped, not verbatim — but never asserted against a fixed ceiling:
    // the store clamps against ITS OWN Date.now(), a tick after this
    // test's `now`, so `<= now + 60min` flakes by a millisecond under CI
    // load. The bound that matters is "nowhere near the bogus stamp".
    expect(store.map['1'].updatedAt).toBeGreaterThan(now)
    expect(store.map['1'].updatedAt).toBeLessThan(now + 10 * 365 * 86_400_000)
    // The property that matters: it cannot pin the rating forever — an
    // honest write past the window beats it.
    store.setRating(1, 4, now + 25 * 60 * 60 * 1000)
    expect(store.ratingFor(1)).toBe(4)
  })

  test('ratings.json rows carry the id and sort by it', () => {
    const store = useRatingStore()
    store.setRating(20, 4, 3_000)
    store.setRating(3, 1, 1_000)
    expect(ratingsToRows(store.map)).toEqual([
      { id: 3, rating: 1, count: 1, updatedAt: 1_000 },
      { id: 20, rating: 4, count: 1, updatedAt: 3_000 },
    ])
  })
})
