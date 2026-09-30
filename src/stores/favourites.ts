import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { getCatalog } from '../lib/catalog'

/**
 * Favourited variant ids, with DELETE MARKERS (ADR-0031).
 *
 * Seeded from the user's favourites in the data snapshot on first run and
 * persisted to localStorage under `mealime-planner:v1:favourites`.
 *
 * Internally the truth is a record per recipe — `{favorited, updatedAt}`
 * — and the live `Set` is MATERIALIZED from the records that are
 * `favorited: true`. A plain set could only ever union, which means a
 * peer that un-starred a recipe would see it spring back to life on the
 * next push from anyone (the delete anomaly). Tombstones reconcile that,
 * with the same last-writer-wins-by-`updatedAt` rule the household
 * ratings use — ONE merge rule for the whole preference surface.
 *
 * UNCHANGED BY ADR-0031, deliberately: the seeding, the public
 * `Set<number>` interface, the persisted ARRAY format, and the
 * `favourites.json` backup slice. Tombstones are in-memory only — a
 * backup carries the starred recipes, not the tombstones, and they are
 * compact by construction (a tombstone is overwritten by the next record
 * for that recipe, and never needs a sweep).
 */

export interface FavouriteRecord {
  /** True = starred, false = the delete marker. */
  favorited: boolean
  /** Unix ms of the last write. The merge key. */
  updatedAt: number
}

/** variantId → record. Keys are numeric variant ids, as strings in JSON. */
export type FavouritesMap = Record<string, FavouriteRecord>

function materialize(records: FavouritesMap): Set<number> {
  const out = new Set<number>()
  for (const [key, record] of Object.entries(records)) {
    if (record.favorited) out.add(Number(key))
  }
  return out
}

/** Ids → records, all starred. `stamp` is the merge key they carry. */
function fromIds(ids: Iterable<number>, stamp: number): FavouritesMap {
  const out: FavouritesMap = {}
  for (const id of ids) {
    if (Number.isFinite(id)) out[String(id)] = { favorited: true, updatedAt: stamp }
  }
  return out
}

/** Sanitize an untrusted records payload (a room peer). */
export function sanitizeFavourites(value: unknown): FavouritesMap {
  const out: FavouritesMap = {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return out
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!/^\d+$/.test(key)) continue
    if (typeof entry !== 'object' || entry === null) continue
    const { favorited, updatedAt } = entry as Partial<FavouriteRecord>
    if (typeof favorited !== 'boolean') continue
    const stamp = Number(updatedAt)
    out[key] = {
      favorited,
      updatedAt: Number.isFinite(stamp) && stamp >= 0 ? stamp : 0,
    }
  }
  return out
}

export const useFavouritesStore = defineStore(
  'favourites',
  () => {
    /** The timestamped truth: one record per recipe, stars AND tombstones. */
    const records = ref<FavouritesMap>({})
    /**
     * The live set, MATERIALIZED from `records` by every write. Public
     * API, Pinia state and the persisted shape all stay a `Set<number>`.
     *
     * A real ref (not a computed): pinia-plugin-persistedstate hydrates
     * by ASSIGNING the persisted value, and it must be able to write it.
     * It is kept in sync inside `commit()` rather than by a watcher, so a
     * caller that toggles and then reads — or the room's `snapshot()` —
     * never sees a stale set.
     */
    const ids = ref(new Set<number>())
    /** True once the store has been seeded/initialized from the catalog. */
    const seeded = ref(false)

    /** The one place records change: records first, then the live set. */
    function commit(next: FavouritesMap): void {
      records.value = next
      ids.value = materialize(next)
    }

    // Hydration: the persisted payload is the id ARRAY (format unchanged),
    // so the records are rebuilt from it — stamp 0, because a bare restored
    // id is older information than any record a peer has sent since.
    watch(ids, (next) => {
      if (next.size > 0 && Object.keys(records.value).length === 0) {
        commit(fromIds(next, 0))
      }
    })

    function isFavourite(variantId: number): boolean {
      return ids.value.has(variantId)
    }

    /**
     * Star/un-star, stamped with the time of the write. `updatedAt` is
     * injectable so the merge rules can be tested with a synthetic clock.
     */
    function toggleFavourite(variantId: number, updatedAt: number = Date.now()): void {
      const key = String(variantId)
      const stamp = Number.isFinite(updatedAt) && updatedAt >= 0 ? updatedAt : Date.now()
      const favorited = !ids.value.has(variantId)
      commit({ ...records.value, [key]: { favorited, updatedAt: stamp } })
    }

    /**
     * Reconcile a peer's records: PER-KEY last-writer-wins by
     * `updatedAt`, so a later un-star really un-stars and an older
     * un-star does not resurrect a star. Never a wholesale replace
     * (ADR-0031).
     */
    function mergeRemote(incoming: unknown): void {
      const clean = sanitizeFavourites(incoming)
      if (Object.keys(clean).length === 0) return
      const next = { ...records.value }
      for (const [key, record] of Object.entries(clean)) {
        const local = next[key]
        if (local && record.updatedAt <= local.updatedAt) continue
        next[key] = record
      }
      commit(next)
    }

    /**
     * First-run seeding from the catalog snapshot. Only ADDS: an id we
     * already hold a record for (e.g. a room merge that landed before the
     * catalog finished loading) keeps its record — a seed is a default,
     * not an authority.
     */
    function seedFrom(catalogIds: Iterable<number>): void {
      const next = { ...records.value }
      let changed = false
      for (const id of catalogIds) {
        if (!Number.isFinite(id)) continue
        const key = String(id)
        if (key in next) continue
        next[key] = { favorited: true, updatedAt: 0 }
        changed = true
      }
      if (changed) commit(next)
    }

    /** Replace the set wholesale (backup import) — fresh local truth. */
    function replaceAll(newIds: number[]): void {
      commit(
        fromIds(
          newIds.filter((n) => Number.isFinite(n)),
          Date.now(),
        ),
      )
    }

    return { ids, records, replaceAll, seedFrom, seeded, isFavourite, toggleFavourite, mergeRemote }
  },
  {
    persist: {
      key: 'mealime-planner:v1:favourites',
      pick: ['ids'],
      // Sets don't round-trip through JSON — persist as an array. The
      // format is UNCHANGED by ADR-0031: tombstones stay in memory.
      serializer: {
        serialize: (state) => JSON.stringify([...(state.ids as Set<number>)]),
        deserialize: (raw) => ({ ids: new Set(JSON.parse(raw) as number[]) }),
      },
    },
  },
)

const FAVOURITES_KEY = 'mealime-planner:v1:favourites'

/**
 * Initialize favourites after the catalog loads: if nothing was persisted
 * yet, seed from the snapshot's favourited variants.
 */
export function initFavourites(): Promise<void> {
  return getCatalog().then((catalog) => {
    const store = useFavouritesStore()
    if (localStorage.getItem(FAVOURITES_KEY) === null) {
      store.seedFrom(catalog.favouriteIds)
    }
    store.seeded = true
  })
}
