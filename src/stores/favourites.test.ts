import { beforeEach, describe, expect, test } from 'bun:test'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { DEFAULT_STAMP, useFavouritesStore } from './favourites'

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

  test('the live set is correct on the FIRST read — no flush window', async () => {
    // `ids` is derived from `records`, so hydration (which assigns
    // `records` directly) is visible immediately. The earlier mirrored-ref
    // design needed a watcher, and a toggle landing before that watcher
    // ran dropped every persisted favourite.
    const store = useFavouritesStore()
    store.records = { '10': { favorited: true, updatedAt: DEFAULT_STAMP } }
    expect([...store.ids]).toEqual([10])
    // A toggle issued before any Vue flush must not lose the saved id.
    store.toggleFavourite(11, 5_000)
    expect([...store.ids].sort((a, b) => a - b)).toEqual([10, 11])
    await nextTick()
    expect(store.isFavourite(10)).toBe(true)
  })

  test('seeding and hydration write DEFAULT_STAMP (startup, not opinion)', () => {
    const store = useFavouritesStore()
    store.seedFrom([1, 2])
    expect(store.records['1'].updatedAt).toBe(DEFAULT_STAMP)
    expect(store.records['2'].updatedAt).toBe(DEFAULT_STAMP)
    // A real toggle is stamped with the clock — the room watcher uses the
    // difference to tell a startup write from a household opinion.
    store.toggleFavourite(1, 9_000)
    expect(store.records['1']).toEqual({ favorited: false, updatedAt: 9_000 })
    // And a default stamp never overwrites a real one.
    store.seedFrom([1])
    expect(store.records['1'].updatedAt).toBe(9_000)
  })
})

describe('importFavourites (ADR-0058, amended: full override)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  test('override: payload ids starred at now, set members NOT in the payload tombstoned at now', () => {
    const store = useFavouritesStore()
    store.toggleFavourite(5, 1_000) // will NOT be in the payload
    store.toggleFavourite(8, 1_000) // will NOT be in the payload
    const { added, removed } = store.importFavourites([5, 6, 7], 9_000)
    expect(added).toBe(2) // 6 and 7 were not favourited before
    expect(removed).toBe(1) // only 8 leaves the set
    expect(store.isFavourite(6)).toBe(true)
    expect(store.records['6']).toEqual({ favorited: true, updatedAt: 9_000 })
    // The removal is a FRESH TOMBSTONE, never a silent delete: a peer
    // merges per key and an absent key means "don't touch" (ADR-0031).
    expect(store.isFavourite(8)).toBe(false)
    expect(store.records['8']).toEqual({ favorited: false, updatedAt: 9_000 })
  })

  test('an already-starred payload id is RE-STAMPED — the import is a new opinion', () => {
    const store = useFavouritesStore()
    store.toggleFavourite(5, 1_000)
    const { added } = store.importFavourites([5], 9_000)
    expect(added).toBe(0)
    expect(store.records['5']).toEqual({ favorited: true, updatedAt: 9_000 })
  })

  test('re-stars a locally un-starred recipe (the import is an explicit ask)', () => {
    const store = useFavouritesStore()
    store.toggleFavourite(5, 1_000)
    store.toggleFavourite(5, 2_000) // tombstone
    expect(store.isFavourite(5)).toBe(false)
    const { added, removed } = store.importFavourites([5], 9_000)
    expect(added).toBe(1)
    expect(removed).toBe(0)
    expect(store.isFavourite(5)).toBe(true)
    expect(store.records['5']).toEqual({ favorited: true, updatedAt: 9_000 })
  })

  test('an import lands in the household sync as an ordinary opinion — stars AND removals', () => {
    const a = useFavouritesStore()
    a.toggleFavourite(1, 1_000)
    a.importFavourites([3], 4_000)
    setActivePinia(createPinia())
    const b = useFavouritesStore()
    b.toggleFavourite(1, 1_000) // b also has 1 starred
    b.mergeRemote(a.records)
    expect(b.isFavourite(3)).toBe(true)
    // The import's tombstone for 1 propagates: the set is the payload's.
    expect(b.isFavourite(1)).toBe(false)
    expect(b.records['1']).toEqual({ favorited: false, updatedAt: 4_000 })
  })

  test('removal-only import (empty payload) still writes and reports honestly', () => {
    const store = useFavouritesStore()
    store.toggleFavourite(1, 1_000)
    store.toggleFavourite(2, 1_000)
    const { added, removed } = store.importFavourites([], 9_000)
    expect(added).toBe(0)
    expect(removed).toBe(2)
    expect([...store.ids]).toEqual([])
    expect(store.records['1']).toEqual({ favorited: false, updatedAt: 9_000 })
    expect(store.records['2']).toEqual({ favorited: false, updatedAt: 9_000 })
  })

  test('an import after seedFrom wipes the seed down to the payload', () => {
    const store = useFavouritesStore()
    store.seedFrom([1, 2, 3])
    const { added, removed } = store.importFavourites([2, 9], 9_000)
    expect(added).toBe(1) // 9 is new
    expect(removed).toBe(2) // 1 and 3 leave
    expect([...store.ids].sort()).toEqual([2, 9])
  })

  test('importing the exact current set is an honest no-op ({added: 0, removed: 0})', () => {
    const store = useFavouritesStore()
    store.importFavourites([1, 2], 1_000)
    const { added, removed } = store.importFavourites([1, 2], 9_000)
    expect(added).toBe(0)
    expect(removed).toBe(0)
    expect([...store.ids].sort()).toEqual([1, 2])
  })

  test('non-finite ids are skipped, never starred', () => {
    const store = useFavouritesStore()
    const { added, removed } = store.importFavourites([Number.NaN, 5], 9_000)
    expect(added).toBe(1)
    expect(removed).toBe(0)
    expect(store.isFavourite(5)).toBe(true)
  })
})
