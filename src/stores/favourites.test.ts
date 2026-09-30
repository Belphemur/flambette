import { beforeEach, describe, expect, test } from 'bun:test'
import { createPinia, setActivePinia } from 'pinia'
import { useFavouritesStore } from './favourites'

/**
 * Favourite reconciliation (ADR-0031): a favourited set WITH delete
 * markers, reconciled per record, newest `updatedAt` wins. Synthetic
 * timestamps throughout (the `toggleFavourite` seam) so nothing depends
 * on the wall clock.
 *
 * The public `Set<number>` interface, the seeding and the persisted array
 * format are UNCHANGED by ADR-0031 — only the internal bookkeeping is.
 */
describe('useFavouritesStore (ADR-0031 tombstones)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  /** A store on its OWN pinia — i.e. a different device. */
  function peerStore() {
    setActivePinia(createPinia())
    return useFavouritesStore()
  }

  test('toggle stars and un-stars, stamping the write', () => {
    const store = useFavouritesStore()
    store.toggleFavourite(5, 1_000)
    expect(store.isFavourite(5)).toBe(true)
    expect(store.records['5']).toEqual({ favorited: true, updatedAt: 1_000 })
    store.toggleFavourite(5, 2_000)
    expect(store.isFavourite(5)).toBe(false)
    // The un-star leaves a TOMBSTONE, not a missing key.
    expect(store.records['5']).toEqual({ favorited: false, updatedAt: 2_000 })
  })

  test('a later tombstone un-stars on the peer (the delete anomaly, fixed)', () => {
    const a = useFavouritesStore()
    a.toggleFavourite(5, 1_000) // A stars it
    const b = peerStore()
    b.mergeRemote(a.records)
    expect(b.isFavourite(5)).toBe(true)

    b.toggleFavourite(5, 5_000) // B un-stars, later
    expect(b.isFavourite(5)).toBe(false)
    a.mergeRemote(b.records)
    expect(a.isFavourite(5)).toBe(false) // and the star does NOT come back
  })

  test('an OLDER tombstone is discarded — it cannot resurrect a deleted star', () => {
    const store = useFavouritesStore()
    store.mergeRemote({ '9': { favorited: false, updatedAt: 1_000 } }) // an old un-star
    store.toggleFavourite(9, 9_000) // starred later
    store.mergeRemote({ '9': { favorited: false, updatedAt: 1_000 } }) // replayed
    expect(store.isFavourite(9)).toBe(true)
  })

  test('an equal timestamp is not a new opinion (no echo flapping)', () => {
    const store = useFavouritesStore()
    store.toggleFavourite(3, 500)
    store.mergeRemote({ '3': { favorited: false, updatedAt: 500 } })
    expect(store.isFavourite(3)).toBe(true)
  })

  test('per-key merge: a peer starring one recipe never touches another', () => {
    const store = useFavouritesStore()
    store.toggleFavourite(1, 1_000)
    store.toggleFavourite(2, 1_000)
    store.mergeRemote({ '3': { favorited: true, updatedAt: 10 } })
    expect([...store.ids].sort()).toEqual([1, 2, 3])
  })

  test('seedFrom only ADDS — a record we already hold is never clobbered', () => {
    const store = useFavouritesStore()
    store.mergeRemote({ '4': { favorited: false, updatedAt: 7 } }) // a peer un-starred it
    store.seedFrom([4, 5, 6])
    expect(store.isFavourite(4)).toBe(false) // the newer peer record wins
    expect(store.isFavourite(5)).toBe(true)
    expect(store.isFavourite(6)).toBe(true)
  })

  test('replaceAll (backup import) is fresh local truth', () => {
    const store = useFavouritesStore()
    store.toggleFavourite(1, 1_000)
    store.replaceAll([7, 8])
    expect([...store.ids].sort()).toEqual([7, 8])
    expect(store.records['1']).toBeUndefined()
  })

  test('an untrusted payload is sanitized, not merged blind', () => {
    const store = useFavouritesStore()
    store.mergeRemote({
      '5': { favorited: 'yes', updatedAt: 1 },
      '6': { favorited: true, updatedAt: 'later' },
      nope: { favorited: true, updatedAt: 1 },
    })
    expect(store.records).toEqual({ '6': { favorited: true, updatedAt: 0 } })
    expect(store.isFavourite(6)).toBe(true)
  })
})
