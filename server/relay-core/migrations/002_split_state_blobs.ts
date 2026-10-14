/**
 * Migration 002 — split the deprecated `room.state` blobs into per-store
 * rows (the Durable Object's real data migration, ADR-0088 §4).
 *
 * Up: for each synchronized store, copy the store's subtree out of every
 * blob that HAS the key — the `json_type` guard is the presence test,
 * because `json_extract` cannot distinguish an absent key from an explicit
 * JSON `null`, and `planIdentity: null` is a real answer (ADR-0034) — then
 * NULL the column. The column stays (deprecated, always NULL afterwards):
 * an additive step cannot fail on any workerd SQLite vintage, and the
 * peer_serial precedent shows additive beats clever here.
 *
 * `OR IGNORE` keeps the step re-runnable: a partially applied split
 * converges instead of colliding on the primary key, and a fully split
 * database re-inserts nothing (every blob is already NULL). On a fresh
 * Bun database the same statements run over zero rows — the Bun side
 * ships 002 as the no-op it is there, so both runtimes agree on the
 * version history.
 *
 * A legacy blob that is not valid JSON at all (a truncated write from a
 * pre-ADR relay) is kept out of the split by the `json_valid` guard —
 * `json_type` RAISES on malformed text, and one poisoned row must not
 * fail the whole migration before the trailing `UPDATE` can clear it.
 * The blob is nulled either way, so the room is served with empty state,
 * which is what the previous codec's parse failure did (qodo review).
 *
 * The up half is SQL generated over the store vocabulary, but it cannot be
 * a static `up` string list: it needs the vocabulary at build-of-statement
 * time, so it stays a registered `migrate` hook (SQL where it is SQL, a
 * hook where it cannot be a literal list).
 *
 * Down (explicit rollback only): re-fold every per-store row back into the
 * blob, key by key — `json_set` with a `json()` wrapper so the stored text
 * lands as JSON, not as a quoted string. The fold is best-effort by
 * design: keys that were ABSENT in the original legacy blob come back as
 * explicit JSON `null`s, which the pre-per-store reader treats exactly
 * like an absent key (empty store state). A room with no rows in a store
 * keeps that key out of its blob entirely (the per-statement `EXISTS`
 * guard), so a rolled-back database is not littered with null-object
 * blobs for rooms that never had the store.
 *
 * The fold cannot be a static `down` string list: it must skip stores
 * whose tables a LATER migration created and a prior rollback step has
 * already dropped (rolling back to version 2 means the version-2 world —
 * a store added at version 3 has no place in the blob it folds into),
 * and SQLite has no pure-SQL way to reference a table conditionally. So
 * the fold is a `migrateDown` hook over the live vocabulary, guarded per
 * table by `sqlite_master`.
 */

import { SYNCED_STORES, storeTableName, type SyncedStore } from '../stores'
import type { MigrationStep } from '../migrations'

/** Re-fold one store's rows into the legacy blob under the store's key. */
function foldStoreRowsSql(store: SyncedStore): string {
  const table = storeTableName(store)
  return `
UPDATE room SET state = COALESCE(json_set(COALESCE(state, '{}'), '$.${store}', json(
  (SELECT value FROM ${table} WHERE ${table}.code = room.code)
)), state)
WHERE EXISTS (SELECT 1 FROM ${table} WHERE ${table}.code = room.code)`
}

export const MIGRATION_002: MigrationStep = {
  version: 2,
  name: 'split room state blobs into per-store rows',
  up: [],
  down: [],
  migrate(db) {
    for (const store of SYNCED_STORES) {
      const path = `$.${store}`
      db.exec(
        `INSERT OR IGNORE INTO ${storeTableName(store)} (code, value, created_at, updated_at)
         SELECT code,
           CASE json_type(state, '${path}')
             WHEN 'null' THEN 'null'
             WHEN 'text' THEN json_quote(json_extract(state, '${path}'))
             WHEN 'true' THEN 'true'
             WHEN 'false' THEN 'false'
             ELSE json_extract(state, '${path}')
           END,
           created_at,
           updated_at
         FROM room
         WHERE state IS NOT NULL AND json_valid(state) AND json_type(state, '${path}') IS NOT NULL`,
      )
    }
    db.exec('UPDATE room SET state = NULL WHERE state IS NOT NULL')
  },
  migrateDown(db) {
    for (const store of SYNCED_STORES) {
      const table = storeTableName(store)
      // Only fold stores whose table still exists — a later migration's
      // table is not this step's world, and its down already dropped it.
      if (db.all("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", table).length === 0)
        continue
      db.exec(foldStoreRowsSql(store))
    }
  },
}