import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { getCatalog } from '../lib/catalog'

/**
 * Favourited variant ids, with DELETE MARKERS (ADR-0031).
 *
 * Seeded from the user's favourites in the data snapshot on first run and
 * persisted to localStorage under `mealime-planner:v1:favourites`.
 *
 * Internally the truth is a record per recipe — `{favorited, updatedAt}`
 * — and the live `Set` is a COMPUTED materialized from the records that
 * are `favorited: true`. A plain set could only ever union, which means
 * a peer that un-starred a recipe would see it spring back to life on the
 * next push from anyone (the delete anomaly). Tombstones reconcile that,
 * with the same last-writer-wins-by-`updatedAt` rule the household
 * ratings use — ONE merge rule for the whole preference surface.
 *
 * `records` being the single source of truth (rather than a `Set` kept in
 * sync beside it) is what makes persistence hydration synchronous: the
 * plugin writes `records` directly, and the derived set is correct on the
 * very next read — no flush window in which a toggle could overwrite the
 * saved ids, and no stale set for the room's `snapshot()` to publish.
 *
 * UNCHANGED BY ADR-0031, deliberately: the seeding, the public
 * `Set<number>` interface, the persisted ARRAY format, and the
 * `favourites.json` backup slice. Tombstones are in-memory only — a
 * backup carries the starred recipes, not the tombstones.
 */

export interface FavouriteRecord {
  /** True = starred, false = the delete marker. */
  favorited: boolean
  /** Unix ms of the last write. The merge key. */
  updatedAt: number
}

/** variantId → record. Keys are numeric variant ids, as strings in JSON. */
export type FavouritesMap = Record<string, FavouriteRecord>

/**
 * The stamp carried by a DEFAULT, not an opinion: the first-run catalog
 * seed and persistence hydration both write stamp 0. The room watcher uses
 * it to tell "the household changed its mind" from "this device finished
 * starting up", so a joiner can never publish its seed over the room's
 * state (see src/stores/room.ts).
 */
export const DEFAULT_STAMP = 0

function materialize(records: FavouritesMap): Set<number> {
  const out = new Set<number>()
  for (const [key, record] of Object.entries(records)) {
    if (record.favorited) out.add(Number(key))
  }
  return out
}

/** Ids → records, all starred at `stamp`. */
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
      updatedAt: Number.isFinite(stamp) && stamp >= 0 ? stamp : DEFAULT_STAMP,
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
     * The live set, derived from `records` on every read — always in sync
     * by construction, which is what the room's `snapshot()` relies on.
     */
    const ids = computed(() => materialize(records.value))
    /** True once the store has been seeded/initialized from the catalog. */
    const seeded = ref(false)

    function isFavourite(variantId: number): boolean {
      return ids.value.has(variantId)
    }

    /**
     * Star/un-star, stamped with the time of the write. `updatedAt` is
     * injectable so the merge rules can be tested with a synthetic clock.
     */
    function toggleFavourite(variantId: number, updatedAt: number = Date.now()): void {
      const key = String(variantId)
      const stamp = Number.isFinite(updatedAt) && updatedAt > DEFAULT_STAMP ? updatedAt : Date.now()
      const favorited = !ids.value.has(variantId)
      records.value = { ...records.value, [key]: { favorited, updatedAt: stamp } }
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
      records.value = next
    }

    /**
     * First-run seeding from the catalog snapshot. Only ADDS, and always
     * at `DEFAULT_STAMP`: an id we already hold a record for (e.g. a room
     * merge that landed before the catalog finished loading) keeps it,
     * and a seed is a default, never an authority.
     */
    function seedFrom(catalogIds: Iterable<number>): void {
      const next = { ...records.value }
      let changed = false
      for (const id of catalogIds) {
        if (!Number.isFinite(id)) continue
        const key = String(id)
        if (key in next) continue
        next[key] = { favorited: true, updatedAt: DEFAULT_STAMP }
        changed = true
      }
      if (changed) records.value = next
    }

    /**
     * Migration import (ADR-0058, amended): a FULL OVERRIDE — after a
     * successful import the favourited set is EXACTLY the payload. Every
     * payload id is starred at a FRESH stamp (the import is a new
     * opinion; an already-starred id is re-stamped, not preserved), and
     * every currently-starred id NOT in the payload is un-starred via a
     * fresh tombstone — never a silent delete. The tombstones are
     * load-bearing: household peers reconcile PER KEY and an absent key
     * means "don't touch" (ADR-0031), so a plain wipe (`replaceAll`) could
     * never propagate the removals to the other devices. Tombstones do.
     * Records that are ALREADY tombstones stay untouched — re-tombstoning
     * them would add no information. `records` is written even when only
     * removals landed. Returns `{added, removed}` so the report can be
     * honest about both directions.
     */
    function importFavourites(
      variantIds: Iterable<number>,
      now: number = Date.now(),
    ): { added: number; removed: number } {
      const stamp = Number.isFinite(now) && now > DEFAULT_STAMP ? now : Date.now()
      const wanted = new Set<number>()
      const next = { ...records.value }
      for (const id of variantIds) {
        if (!Number.isFinite(id)) continue
        wanted.add(id)
        next[String(id)] = { favorited: true, updatedAt: stamp }
      }
      let added = 0
      for (const id of wanted) {
        if (!ids.value.has(id)) added++
      }
      let removed = 0
      for (const [key, record] of Object.entries(records.value)) {
        if (record.favorited && !wanted.has(Number(key))) {
          next[key] = { favorited: false, updatedAt: stamp }
          removed++
        }
      }
      records.value = next
      return { added, removed }
    }

    /** Replace the set wholesale (backup import) — fresh local truth. */
    function replaceAll(newIds: number[]): void {
      records.value = fromIds(
        newIds.filter((n) => Number.isFinite(n)),
        Date.now(),
      )
    }

    return {
      ids,
      records,
      replaceAll,
      seedFrom,
      seeded,
      isFavourite,
      toggleFavourite,
      mergeRemote,
      importFavourites,
    }
  },
  {
    persist: {
      key: 'mealime-planner:v1:favourites',
      // `records` is the truth, but the ON-DISK format is unchanged by
      // ADR-0031: still a plain array of starred ids (tombstones stay in
      // memory). Hydration therefore rebuilds records at DEFAULT_STAMP.
      pick: ['records'],
      serializer: {
        serialize: (state) =>
          JSON.stringify([...materialize(state.records as FavouritesMap)]),
        deserialize: (raw) => ({ records: fromIds(JSON.parse(raw) as number[], DEFAULT_STAMP) }),
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
