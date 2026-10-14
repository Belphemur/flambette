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
