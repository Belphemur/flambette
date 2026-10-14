/**
 * The synchronized-store vocabulary (ADR-0088 §2).
 *
 * The relay's payload is a bag of independent household stores — one key of
 * `SharedState` per store — and per-store STORAGE (one SQLite table per key,
 * identical on both runtimes) needs the vocabulary stated ONCE, in the core:
 * which keys exist is a DECISION about what the relay synchronizes (ADR-0040),
 * not a storage detail of either adapter.
 *
 * The list must agree with the client's `SharedState` keys, and the
 * agreement is GATED, not assumed: `src/lib/roomSyncStores.ts` carries the
 * runtime key list next to the interface it mirrors (a compile-time
 * assertion in `src/stores/room.ts` fails the build when the two drift),
 * and `stores.test.ts` fails `bun run test:unit` when THIS list and the
 * client's list disagree (ADR-0088 §6). Adding a synchronized store is now
 * a schema migration on BOTH runtimes, in the same change as the entry
 * here — see `.agents/skills/mealime-add-sync-store/SKILL.md`.
 */

import type { SharedSnapshot } from './protocol'

/**
 * The synchronized stores, in the order their payload keys are declared on
 * the client (`src/stores/room.ts`). Every key that can ride the wire is
 * here — including the two the payload attaches special semantics to:
 * `planIdentity` (explicitly nullable, ADR-0034) and `ratingTombstones`
 * (the deletion half of the ratings store, ADR-0082). A key missing from
 * this list is silently dropped from per-store STORAGE while still being
 * fanned out live — the exact drift the cross-check gate exists to catch.
 */
export const SYNCED_STORES = [
  'plan',
  'customItems',
  'checked',
  'cleared',
  'customs',
  'pantry',
  'cookedHistory',
  'filters',
  'favorites',
  'ratings',
  'ratingTombstones',
  'planIdentity',
] as const

export type SyncedStore = (typeof SYNCED_STORES)[number]

/**
 * The per-store table name: `store_` + the SharedState key in snake_case
 * (`customItems` → `store_custom_items`). The prefix keeps a table name
 * clear of both SQL keywords and domain words ("plan") used for something
 * else (ADR-0088 §2).
 */
export function storeTableName(store: SyncedStore): string {
  return `store_${store.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}`
}

/** One per-store row a snapshot writes. */
export interface StoreRow {
  store: SyncedStore
  /**
   * The store's value AS IT ARRIVED — still a JS value. The adapter owns
   * the JSON encoding (it is the storage boundary), and stamps the row's
   * `created_at`/`updated_at` itself, so the core stays clock-free.
   */
  value: unknown
}

/**
 * The per-store rows a snapshot writes: ONLY the keys present in the
 * payload. This is the standing "absence means don't-touch" rule
 * (ADR-0028, per key since ADR-0032/0034) enforced at the shared split, so
 * no adapter can turn a missing key into a wipe (ADR-0088 §1). An explicit
 * `null` is PRESENT — `planIdentity: null` is a real answer ("no current
 * plan", ADR-0034), never silence.
 *
 * Returns null for a null/absent snapshot (a room established with no push
 * yet stores no rows at all).
 */
export function splitSnapshot(state: SharedSnapshot | null | undefined): StoreRow[] | null {
  if (state === null || state === undefined) return null
  const rows: StoreRow[] = []
  for (const store of SYNCED_STORES) {
    const value = (state as Record<string, unknown>)[store]
    // Absent (and `undefined`, its parsed-JSON equivalent) is silence; a
    // key the vocabulary does not know is dropped from storage — an old
    // relay degrades gracefully against a newer client (ADR-0012 rule).
    if (value !== undefined) rows.push({ store, value })
  }
  return rows
}

/** One stored per-store row as a read returns it: raw column TEXT. */
export interface StoredStoreRow {
  store: string
  /**
   * The `value` column verbatim. The CHECK (`json_valid`) makes a corrupt
   * write impossible where the function exists; where it does not (see
   * ADR-0088 §2's workerd caveat), an unparseable row is SKIPPED here — a
   * corrupt store must not kill the room, the same rule the blob codec
   * always had.
   */
  text: string | null
}

/**
 * The per-store statements one write must run, as change detection
 * computed them (ADR-0088 §2). The core decides; the adapters execute.
 */
export interface StoreWritePlan {
  /**
   * Store rows whose text differs from the last-known text — upsert
   * exactly these, in this order.
   */
  changed: { store: SyncedStore; text: string }[]
  /**
   * A `state: null` write (a fresh establishment) clears every store row
   * — the same wipe-overwrite the blob write used to be.
   */
  clearAll: boolean
}

export interface StoreWritePlanner {
  /**
   * Record the raw texts a read returned — the seed change detection
   * compares against. Call this from the adapter's READ path with every
   * row it read (even the ones the joiner skips).
   */
  seed: (code: string, rows: readonly StoredStoreRow[]) => void
  /** The per-store statements a write of `state` must run. */
  plan: (code: string, state: SharedSnapshot | null | undefined) => StoreWritePlan
  /**
   * The last-known serialized text per synchronized store, in
   * `SYNCED_STORES` order — exactly what is on disk once the plan's rows
   * are written (seeded from reads, advanced by `plan`). The grace mirror
   * joins THESE instead of re-reading the tables (kody review): the plan
   * already consulted every text this write touched, so the join costs no
   * extra SELECTs on the write hot path. Warm-seed precondition is the
   * same one `plan`'s "write it" default already relies on.
   */
  knownTexts: (code: string) => readonly (string | null)[]
  /**
   * Forget a code's remembered texts: the room was dropped (expiry or
   * the last peer's leave). Call from the adapters' `drop` so the
   * planner's memory is bounded by the LIVE room set, never by every
   * code the process has ever served (kody review).
   */
  forget: (code: string) => void
}

/**
 * Per-store change detection (ADR-0088 §2): `updated_at` is "when THIS
 * store was last written" — and the core's `touch()` re-writes the whole
 * record to move the expiry clocks, carrying every store with it. Without
 * detection, every keepalive re-serializes and re-upserts every
 * synchronized store and drags each `updated_at` along, which lies about the metadata
 * the per-store tables exist to expose.
 *
 * ONE decision here in the core (ADR-0040): both adapters consume the
 * same plan, so the semantics cannot drift between Bun and workerd.
 *
 * The planner remembers the last-known row TEXT per code+store, seeded
 * from the adapter's read path — the core only ever writes a record it
 * just read (`touch`, `push`, `nextSerial` all read first; `establish`
 * writes `state: null`), so after a restart or a workerd eviction the
 * first write is always preceded by a read on the same instance and the
 * seed is warm. An UNSEED store text defaults to "write it": the safe
 * superset, one redundant upsert at worst, never a lost write.
 *
 * Comparison is on the SERIALIZED text, not the parsed value: the stored
 * text was produced by this same `JSON.stringify` path, so identical
 * values round-trip to identical text, and any key-order or encoding
 * change the client makes shows up as a change — conservative, never
 * silent.
 */
export function createStoreWritePlanner(): StoreWritePlanner {
  const known = new Map<string, string | null>()
  const key = (code: string, store: string): string => `${code}\u0000${store}`
  return {
    seed(code, rows) {
      for (const row of rows) {
        // A text the vocabulary does not know cannot have been written by
        // this binary's tables — skip it, like the joiner does.
        if (!(SYNCED_STORES as readonly string[]).includes(row.store)) continue
        known.set(key(code, row.store), row.text ?? null)
      }
    },
    plan(code, state) {
      const rows = splitSnapshot(state)
      if (!rows) {
        for (const store of SYNCED_STORES) known.set(key(code, store), null)
        return { changed: [], clearAll: true }
      }
      const changed: { store: SyncedStore; text: string }[] = []
      for (const { store, value } of rows) {
        const text = JSON.stringify(value)
        const k = key(code, store)
        if (known.get(k) !== text) {
          known.set(k, text)
          changed.push({ store, text })
        }
      }
      return { changed, clearAll: false }
    },
    forget(code) {
      for (const store of SYNCED_STORES) known.delete(key(code, store))
    },
    knownTexts(code) {
      // `SYNCED_STORES` order is the join order the read path uses, so a
      // caller can zip index-for-index. An unseeded text is `null` — the
      // same read-before-write invariant that keeps `plan` honest covers
      // every core write path (touch, push, nextSerial, establish).
      return SYNCED_STORES.map((store) => known.get(key(code, store)) ?? null)
    },
  }
}

/**
 * The single snapshot a `joined`/fan-out needs, from the per-store rows a
 * read returned. Rows for stores the vocabulary does not know are skipped
 * (they cannot exist on the same binary that wrote them), as are absent
 * and unparseable rows. Returns null when nothing was joined — a room that
 * exists but has never been pushed reads as `state: null`, exactly as the
 * blob did.
 */
export function joinSnapshot(rows: Iterable<StoredStoreRow>): SharedSnapshot | null {
  let snapshot: SharedSnapshot | null = null
  for (const row of rows) {
    if (!(SYNCED_STORES as readonly string[]).includes(row.store)) continue
    if (row.text === null || row.text === undefined) continue
    let value: unknown
    try {
      value = JSON.parse(row.text)
    } catch {
      continue
    }
    ;(snapshot ??= {})[row.store] = value
  }
  return snapshot
}
