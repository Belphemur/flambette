/**
 * The relay's SQLite migrations — ONE runner, ONE step list, BOTH runtimes
 * (ADR-0088 §4).
 *
 * The Bun relay applies the list at startup, before it serves (a relay that
 * answers a half-migrated schema is worse than one that refuses to start);
 * the Durable Object applies it lazily on the first event of each — workerd
 * gives an object no `ctx.storage` before the first event, so "at startup"
 * does not exist there. The runner itself is runtime-neutral: steps are
 * inline TypeScript (the build-less Bun image has no asset filesystem to
 * read `.sql` files from, and a DO bundle would need an import-rule
 * exception to carry them), and the database is reached through the tiny
 * `MigrationDatabase` facade each adapter implements over its own SQL API.
 *
 * Tracking is a `schema_migrations` table, not `PRAGMA user_version`: the
 * runner is one mechanism for two runtimes and workerd's storage SQL does
 * not expose user_version reliably. And like the `#ensureTables` probe it
 * replaces, the runner VERIFIES against the actual database rather than
 * trusting the ledger — a Durable Object can be evicted between events and
 * a test's storage rolled back under it, so a recorded version whose
 * objects are missing is re-applied (every step is written to be safe to
 * re-run: additive DDL, `OR IGNORE`/`OR REPLACE` writes, guarded probes).
 *
 * Steps are NOT wrapped in a transaction: workerd's storage SQL is per-
 * statement atomic and an explicit BEGIN/COMMIT is not portable across the
 * two runtimes' APIs. Idempotence is the recovery story instead.
 */

import { SYNCED_STORES, storeTableName, type SyncedStore } from './stores'

/**
 * The slice of a SQL API the runner needs — implemented over `bun:sqlite`
 * by the Bun adapter, over `ctx.storage.sql` by the Durable Object, and
 * over an in-memory database by the specs.
 */
export interface MigrationDatabase {
  /** Run one statement (DDL or DML), with optional bindings. */
  exec: (sql: string, ...bindings: readonly unknown[]) => void
  /** All rows of a query, as column-name → value records. */
  all: (sql: string, ...bindings: readonly unknown[]) => Record<string, unknown>[]
}

/**
 * One versioned step: plain DDL `statements`, and/or a typed `migrate` for
 * the data reshaping that cannot be expressed as DDL (migration 002). A
 * step may carry both — the statements run first.
 */
export interface MigrationStep {
  readonly version: number
  readonly name: string
  /**
   * Tables and indexes this step guarantees, checked against
   * `sqlite_master` even when the ledger already records the version.
   */
  readonly expects?: readonly string[]
  readonly statements?: readonly string[]
  readonly migrate?: (db: MigrationDatabase) => void
}

/* ------------------------------------------------------------- shared DDL */

/** The ledger the runner itself keeps. Not a step: it exists before step 1. */
const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL
)`

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
 * Bun database it simply never holds anything.
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

/* ------------------------------------------------------- shared row SQL */

/**
 * The store-row DML is core code too, not per-adapter strings: the tables
 * it names are the shared schema's, and two hand-written copies of the
 * same upsert is exactly the drift ADR-0088 exists to prevent. The
 * statements are built from the vocabulary, so the table names cannot go
 * stale — and they are OURS, never user input, so interpolation is safe.
 */

/** Upsert one store row; `created_at` survives an update (first write). */
export function storeUpsertSql(store: SyncedStore): string {
  return (
    `INSERT INTO ${storeTableName(store)} (code, value, created_at, updated_at) VALUES (?, ?, ?, ?) ` +
    `ON CONFLICT (code) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
}

/** Forget one code's rows in one store table. */
export function storeClearSql(store: SyncedStore): string {
  return `DELETE FROM ${storeTableName(store)} WHERE code = ?`
}

/**
 * Upsert the room row itself — shared for the same reason the store-row
 * SQL is: the table is the shared schema's, and the core's records always
 * arrive complete (the core spreads the row it read), so a plain upsert
 * over the unique `code` index serves both runtimes. It is an UPSERT, not
 * INSERT OR REPLACE, deliberately: REPLACE would delete the conflicting
 * row and mint a new rowid, discarding the `id` the row already has (the
 * Durable Object's single room keeps id 1 for its whole life). The
 * deprecated `state` column is written NULL — always, from migration 002
 * onward (ADR-0088 §2/§4).
 */
export const ROOM_UPSERT_SQL = `INSERT INTO room
  (code, rev, state, created_at, updated_at, last_activity, inactivity_at, idle_at, serial)
  VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (code) DO UPDATE SET
    rev = excluded.rev,
    state = excluded.state,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at,
    last_activity = excluded.last_activity,
    inactivity_at = excluded.inactivity_at,
    idle_at = excluded.idle_at,
    serial = excluded.serial`

/** Forget one room row (its per-store rows go with it — see the adapters). */
export const ROOM_DELETE_SQL = 'DELETE FROM room WHERE code = ?'

/**
 * Read one code's row from ONE store table, as raw JSON `text`. One
 * statement per store, deliberately NOT a single UNION ALL across the
 * tables: workerd's storage SQL rejects a compound SELECT with that many
 * terms, and the adapters walk `SYNCED_STORES` anyway.
 */
export function storeRowSql(store: SyncedStore): string {
  return `SELECT value AS text FROM ${storeTableName(store)} WHERE code = ?`
}

/* ---------------------------------------------------------------- steps */

/**
 * Migration 001 — the fresh-install schema: the room row, the floor tables
 * and one table per synchronized store.
 *
 * The `migrate` half reconciles a database that predates this schema (the
 * Durable Object's live deployments): `CREATE TABLE IF NOT EXISTS` cannot
 * widen the existing `room` table with `updated_at`, so the column is
 * probed and added with a guarded `ALTER TABLE` — additive, and safe to
 * re-run because the probe answers for the column's presence, not for the
 * ledger. Pre-existing rows are backfilled to `last_activity`, the closest
 * honest answer to "when was this last written".
 */
const MIGRATION_001: MigrationStep = {
  version: 1,
  name: 'per-store base schema',
  expects: [
    'room',
    'room_code_idx',
    'rev_floor',
    'peer_serial',
    ...SYNCED_STORES.map(storeTableName),
  ],
  statements: [
    ROOM_DDL,
    ROOM_CODE_INDEX_DDL,
    FLOOR_DDL,
    PEER_SERIAL_DDL,
    ...SYNCED_STORES.map(storeTableDdl),
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

/**
 * Migration 002 — split the deprecated `room.state` blobs into per-store
 * rows (the Durable Object's real data migration). Per store: copy the
 * subtree out of every blob that HAS the key — the `json_type` guard is
 * the presence test, because `json_extract` cannot distinguish an absent
 * key from an explicit JSON `null`, and `planIdentity: null` is a real
 * answer (ADR-0034) — then NULL the column. The column stays (deprecated,
 * always NULL afterwards): an additive step cannot fail on any workerd
 * SQLite vintage, and the peer_serial precedent shows additive beats
 * clever here.
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
 */
const MIGRATION_002: MigrationStep = {
  version: 2,
  name: 'split room state blobs into per-store rows',
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
}

/** The ordered migration list — append-only; never renumber a shipped step. */
export const MIGRATIONS: readonly MigrationStep[] = [MIGRATION_001, MIGRATION_002]

/** Apply every pending step, ascending, and verify what the ledger claims. */
export function applyMigrations(db: MigrationDatabase, now: () => number): void {
  db.exec(SCHEMA_MIGRATIONS_DDL)
  const applied = new Set(
    db.all('SELECT version FROM schema_migrations').map((row) => Number(row.version)),
  )
  for (const step of MIGRATIONS) {
    if (applied.has(step.version) && stepVerified(db, step)) continue
    for (const statement of step.statements ?? []) db.exec(statement)
    step.migrate?.(db)
    // OR IGNORE: a re-applied step keeps its original application stamp.
    db.exec(
      'INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
      step.version,
      step.name,
      now(),
    )
  }
}

/**
 * The `#ensureTables` rule, kept: "did this step run" is answered from the
 * actual database, not from the ledger — a rolled-back storage would leave
 * the ledger claiming tables that no longer exist.
 */
function stepVerified(db: MigrationDatabase, step: MigrationStep): boolean {
  if (!step.expects || step.expects.length === 0) return true
  const present = new Set(
    db.all("SELECT name FROM sqlite_master WHERE type IN ('table', 'index')").map((row) =>
      String(row.name),
    ),
  )
  return step.expects.every((name) => present.has(name))
}
