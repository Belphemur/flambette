/**
 * Migration 001 — the per-store base schema (ADR-0088 §1).
 *
 * One TS module embedding the SQL for BOTH directions (the folder shape:
 * the build-less Bun image has no asset filesystem to read `.sql` files
 * from, and a DO bundle would need an import-rule exception to carry them
 * — so the SQL travels as template literals in code).
 *
 * The `up` half creates the fresh-install schema: the room row, the floor
 * tables and one table per synchronized store.
 *
 * The `migrate` hook reconciles a database that predates this schema (the
 * Durable Object's live deployments): `CREATE TABLE IF NOT EXISTS` cannot
 * widen the existing `room` table with `updated_at`, so the column is
 * probed and added with a guarded `ALTER TABLE` — additive, and safe to
 * re-run because the probe answers for the column's presence, not for the
 * ledger. Pre-existing rows are backfilled to `last_activity`, the closest
 * honest answer to "when was this last written".
 *
 * The `down` half is the explicit rollback (the runner never invokes it on
 * its own): every object `up` created is dropped. The `updated_at` column
 * the `migrate` hook adds is NOT removed — SQLite cannot drop a column
 * without a table rebuild that is not portable across the two runtimes'
 * SQL APIs, and at target version 0 the whole `room` table goes anyway.
 */

import { SYNCED_STORES, storeTableName, type SyncedStore } from '../stores'
import type { MigrationStep } from '../migrations'

/* ------------------------------------------------------------- shared DDL */

/**
 * The room row. The shape is IDENTICAL on both runtimes: one table serves
 * a Bun relay's many rooms (keyed by the unique `code`) and a Durable
 * Object's single room the same way, so every query — written once, in the
 * adapters — works on either. `id` stays the primary key for the same
 * reason the column set is additive: the DO's pre-ADR-0088 databases
 * already carry this exact shape, and a primary-key change is a table
 * rebuild, not a migration this runner should have to express. Uniqueness
 * of `code` — what the upserts actually need — is its own index, which a
 * legacy database gains additively.
 *
 * `state` is DEPRECATED (ADR-0088 §2/§4): the pre-per-store blob column,
 * kept — and only ever NULL from migration 002 onward — because an
 * additive step cannot fail on any workerd SQLite vintage. The Bun schema
 * carries the same column so both runtimes run the SAME steps: on a fresh
 * Bun database it simply never holds anything. `idle_at` is retired the
 * same way (ADR-0038's addendum): the second expiry clock collapsed into
 * `inactivity_at` — the ONE deadline — but the column is NOT NULL on
 * databases that predate the unification and SQLite cannot drop it
 * without a table rebuild, so it is written as a mirror of `inactivity_at`
 * and never read.
 */
const ROOM_DDL = `
CREATE TABLE IF NOT EXISTS room (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL,
  rev INTEGER NOT NULL,
  state TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_activity INTEGER NOT NULL,
  inactivity_at INTEGER NOT NULL,
  idle_at INTEGER NOT NULL,
  serial INTEGER NOT NULL
)`

/** Room lookups and upserts are by code — the one uniqueness the store needs. */
const ROOM_CODE_INDEX_DDL = 'CREATE UNIQUE INDEX IF NOT EXISTS room_code_idx ON room (code)'

/**
 * The per-code rev floor, which outlives its room (review F4). The peer
 * serial sits in its OWN table rather than as a column here: it was added
 * after the first Durable Object deploy, SQLite cannot widen a table
 * except through a probed `ALTER TABLE`, and `CREATE TABLE IF NOT EXISTS`
 * needs no probe (the recorded peer_serial precedent). Both runtimes keep
 * the two-table shape so one `writeFloor` serves both.
 */
const FLOOR_DDL = `
CREATE TABLE IF NOT EXISTS rev_floor (
  code TEXT PRIMARY KEY,
  rev INTEGER NOT NULL,
  at INTEGER NOT NULL
)`

const PEER_SERIAL_DDL = `
CREATE TABLE IF NOT EXISTS peer_serial (
  code TEXT PRIMARY KEY,
  serial INTEGER NOT NULL
)`

/**
 * One table per synchronized store (ADR-0088 §2): the value is a proper
 * JSON TEXT column with a `json_valid` CHECK — a corrupt write is a
 * constraint failure at write time, not a surprise at read time — plus
 * per-store metadata: when this store was first and last written for this
 * room. The metadata is distinct from the room row's activity clocks,
 * which answer liveness questions, not history questions.
 */
function storeTableDdl(store: SyncedStore): string {
  return `
CREATE TABLE IF NOT EXISTS ${storeTableName(store)} (
  code TEXT PRIMARY KEY,
  value TEXT NOT NULL CHECK (json_valid(value)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`
}

/* ------------------------------------------------------------------ step */

export const MIGRATION_001: MigrationStep = {
  version: 1,
  name: 'per-store base schema',
  expects: [
    'room',
    'room_code_idx',
    'rev_floor',
    'peer_serial',
    ...SYNCED_STORES.map(storeTableName),
  ],
  up: [
    ROOM_DDL,
    ROOM_CODE_INDEX_DDL,
    FLOOR_DDL,
    PEER_SERIAL_DDL,
    ...SYNCED_STORES.map(storeTableDdl),
  ],
  down: [
    // Descending dependency order; `DROP TABLE` removes its indexes with it.
    ...SYNCED_STORES.map((store) => `DROP TABLE IF EXISTS ${storeTableName(store)}`),
    'DROP TABLE IF EXISTS peer_serial',
    'DROP TABLE IF EXISTS rev_floor',
    'DROP INDEX IF EXISTS room_code_idx',
    'DROP TABLE IF EXISTS room',
  ],
  migrate(db) {
    let hasUpdatedAt = true
    try {
      db.exec('SELECT updated_at FROM room LIMIT 1')
    } catch {
      hasUpdatedAt = false
    }
    if (!hasUpdatedAt) {
      db.exec('ALTER TABLE room ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0')
      db.exec('UPDATE room SET updated_at = last_activity')
    }
  },
}