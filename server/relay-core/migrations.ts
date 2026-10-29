/**
 * The relay's SQLite migrations — ONE runner, ONE step list, BOTH runtimes
 * (ADR-0088 §4).
 *
 * The Bun relay applies the list at startup, before it serves (a relay that
 * answers a half-migrated schema is worse than one that refuses to start);
 * the Durable Object applies it lazily on the first event of each — workerd
 * gives an object no `ctx.storage` before the first event, so "at startup"
 * does not exist there. The runner itself is runtime-neutral: each step is
 * ONE TypeScript module under `migrations/` that embeds its SQL — for BOTH
 * directions — as template literals (the build-less Bun image has no asset
 * filesystem to read `.sql` files from, and a DO bundle would need an
 * import-rule exception to carry them, but a plain `.ts` import travels in
 * both with no exception), and the database is reached through the tiny
 * `MigrationDatabase` facade each adapter implements over its own SQL API.
 *
 * `up` runs automatically from the ledger: every pending step, ascending,
 * recorded after it applies. `down` NEVER runs automatically — it exists
 * for the explicit ops/rollback entry point (`rollbackTo`) and nothing
 * else, so a botched down migration can never happen as a side effect of
 * an ordinary relay start or object wake.
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

import { storeTableName, type SyncedStore } from './stores'

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
 * One versioned step, as declared by its own module under `migrations/`:
 * the SQL for BOTH directions as template-literal string lists, plus an
 * optional typed `migrate` hook for the data reshaping that cannot be a
 * literal list (migration 002's split). The statements run before the
 * hook, in both directions' conceptual order.
 */
export interface MigrationStep {
  readonly version: number
  readonly name: string
  /**
   * Tables and indexes this step guarantees, checked against
   * `sqlite_master` even when the ledger already records the version.
   */
  readonly expects?: readonly string[]
  /** Forward SQL — applied automatically when the ledger says pending. */
  readonly up: readonly string[]
  /**
   * Rollback SQL — applied ONLY by the explicit `rollbackTo` entry point,
   * never by `applyMigrations`. Every step ships one, even when the honest
   * rollback is "drop what up created".
   */
  readonly down: readonly string[]
  readonly migrate?: (db: MigrationDatabase) => void
  /**
   * Rollback's typed escape hatch, the down twin of `migrate`: for the
   * data reshaping that cannot be a static SQL list (002's fold must
   * skip stores whose tables a prior rollback step already dropped).
   * Runs after `down`, only from `rollbackTo`.
   */
  readonly migrateDown?: (db: MigrationDatabase) => void
}

/** The ledger the runner itself keeps. Not a step: it exists before step 1. */
const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL
)`

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
 * deprecated `state` column is bound by the adapter: during the
 * legacy-blob grace window it carries the record's merged snapshot (the
 * downgrade-safety mirror, ADR-0088's 2026-10-14 addendum — `state`
 * stays a real binding so the SQL is identical on both runtimes and the
 * adapter owns the grace decision); after the window it is bound NULL.
 * The retired `idle_at` column is NOT NULL on
 * every database that predates the expiry clocks' unification (ADR-0038's
 * addendum), and SQLite cannot drop it without a table rebuild the runner
 * refuses to do — so the upsert mirrors the deadline into it. Written,
 * never read.
 */
export const ROOM_UPSERT_SQL = `INSERT INTO room
  (code, rev, state, created_at, updated_at, last_activity, inactivity_at, idle_at, serial)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
 * When the legacy-blob grace window closes (ADR-0088's 2026-10-14
 * addendum): migration 002's ledger stamp plus `graceMs`. The deadline
 * lives in the LEDGER, not the environment — the core cannot read env,
 * and both runtimes must agree (ADR-0040) — so the answer is derived
 * from the one table every deployment of this schema has. A database
 * whose ledger has no version-002 row (a fresh database mid-open, or a
 * rolled-back one) returns 0: the gate is closed and the upsert binds
 * NULL, the pre-grace behaviour.
 *
 * ONE implementation, called once per adapter at store-factory creation
 * and cached there — re-reading the ledger on every write would spend a
 * query per push to answer a question that cannot change within a
 * process's lifetime (a later migration never moves an earlier stamp).
 */
export function readBlobGraceUntil(db: MigrationDatabase, graceMs: number): number {
  const rows = db.all('SELECT applied_at FROM schema_migrations WHERE version = 2')
  const appliedAt = rows[0]?.applied_at
  return appliedAt === undefined ? 0 : Number(appliedAt) + graceMs
}

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

/* The steps live in ONE module each, under `migrations/` — import them in
 * version order. The list stays append-only; never renumber a shipped
 * step, and never reorder: the ledger records versions, not positions. */
import { MIGRATION_001 } from './migrations/001_rooms_and_stores'
import { MIGRATION_002 } from './migrations/002_split_state_blobs'
import { MIGRATION_003 } from './migrations/003_pantry'
import { MIGRATION_004 } from './migrations/004_qty_overrides'

/** The ordered migration list — append-only; never renumber a shipped step. */
export const MIGRATIONS: readonly MigrationStep[] = [
  MIGRATION_001,
  MIGRATION_002,
  MIGRATION_003,
  MIGRATION_004,
]

/** Apply every pending step, ascending, and verify what the ledger claims. */
export function applyMigrations(db: MigrationDatabase, now: () => number): void {
  db.exec(SCHEMA_MIGRATIONS_DDL)
  const applied = new Set(
    db.all('SELECT version FROM schema_migrations').map((row) => Number(row.version)),
  )
  for (const step of MIGRATIONS) {
    if (applied.has(step.version) && stepVerified(db, step)) continue
    for (const statement of step.up) db.exec(statement)
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

/**
 * The explicit rollback entry point — the ONLY way a `down` step ever
 * runs. Walks the recorded steps descending and applies each one's `down`
 * SQL for every version above `target`, removing its ledger row as it
 * goes; versions at or below `target` (and versions the ledger never
 * recorded) are left untouched. An ops tool calls this deliberately —
 * "roll the database back to version N" — and the NEXT ordinary
 * `applyMigrations` will see the rolled-back versions as pending and
 * re-apply their `up`, which is exactly the recovery loop a rollback
 * exists to enable.
 */
export function rollbackTo(db: MigrationDatabase, targetVersion: number): void {
  const applied = new Set(
    db.all('SELECT version FROM schema_migrations').map((row) => Number(row.version)),
  )
  for (const step of [...MIGRATIONS].reverse()) {
    if (step.version <= targetVersion || !applied.has(step.version)) continue
    for (const statement of step.down) db.exec(statement)
    step.migrateDown?.(db)
    db.exec('DELETE FROM schema_migrations WHERE version = ?', step.version)
  }
}
