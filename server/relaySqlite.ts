/**
 * The Bun relay's SQLite store (ADR-0088 §1) — the adapter half that owns
 * STATE, separated from `relay.ts` only so the specs can open a `:memory:`
 * database without starting a server.
 *
 * Every DECISION stays in `relay-core` (ADR-0040): this file implements the
 * core's storage INTENTS (`RoomStore`) over the per-store tables the shared
 * migration runner maintains, using the schema-shaped SQL the core owns.
 * Nothing here decides anything about rooms.
 *
 * The `bun:sqlite` API is declared STRUCTURALLY — the repo ships no
 * `@types/bun` (the ADR forbids adding one), and the adapter should stay
 * honest about how little of Bun it touches, exactly like `relay.ts`'s
 * `Bun.serve` declaration. The built-in module import keeps the relay's
 * zero-runtime-dependency rule intact: `bun:sqlite` ships with Bun.
 */

import { mkdirSync } from 'node:fs'
import { Database } from 'bun:sqlite'
import {
  createStoreWritePlanner,
  joinSnapshot,
  SYNCED_STORES,
  type StoredStoreRow,
} from './relay-core/stores'
import {
  applyMigrations,
  readBlobGraceUntil,
  ROOM_DELETE_SQL,
  ROOM_UPSERT_SQL,
  storeClearSql,
  storeRowSql,
  storeUpsertSql,
  type MigrationDatabase,
} from './relay-core/migrations'
import { ROOM_TTL_MS, STATE_BLOB_GRACE_MS } from './relay-core/policy'
import { type FloorRecord, type RoomRecord, type RoomStore } from './relay-core/lifecycle'

/**
 * Bun's `Database`, as declared in `./bun-sqlite.d.ts` — the structural
 * declaration stands in for the `@types/bun` package the repo does not
 * ship (and the ADR forbids adding).
 */
type SqliteDatabase = Database

/** The room columns, already typed. */
interface RoomSqlRow {
  code: unknown
  rev: unknown
  created_at: unknown
  updated_at: unknown
  last_activity: unknown
  /** The room's expiry deadline — the ONE clock (ADR-0038's addendum). */
  inactivity_at: unknown
  serial: unknown
}

function num(value: unknown): number {
  return Number(value)
}

/**
 * Open (and migrate) the relay's database. `RELAY_DB_PATH` supplies the
 * path — the default lives in `relay.ts`, because configuration is the
 * adapter's, not the store's. `:memory:` is an explicit opt-in for tests.
 *
 * WAL so a long-running household never loses a write to a checkpoint
 * stall, and a `busy_timeout` so a lock wait is a wait, not an error.
 * Migrations run here, so a caller that opens before serving has applied
 * them before its first request — the startup order the ADR-0088 §4 asks
 * for on this runtime.
 */
export function openRelayDatabase(path: string): SqliteDatabase {
  if (path !== ':memory:') {
    // SQLite creates the file, not its directory — a first `docker compose
    // up` would otherwise die on the open before the volume note is read.
    const slash = path.lastIndexOf('/')
    if (slash > 0) mkdirSync(path.slice(0, slash), { recursive: true })
  }
  const db = new Database(path) as unknown as SqliteDatabase
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 5000')
  applyMigrations(facadeOf(db), () => Date.now())
  return db
}

/**
 * The runner's facade over Bun's database. Bindings go through a prepared
 * statement; bare DDL goes through `exec`, which takes no bindings.
 */
function facadeOf(db: SqliteDatabase): MigrationDatabase {
  return {
    exec: (sql, ...bindings) => {
      if (bindings.length > 0) db.query(sql).run(...bindings)
      else db.exec(sql)
    },
    all: (sql, ...bindings) => db.query(sql).all(...bindings),
  }
}

/**
 * The core's storage intents over the per-store tables — the whole
 * "adapter owns state" half of ADR-0040, now backed by SQLite instead of
 * two Maps (ADR-0088 §1). Built per database; callers derive each code's
 * store from it.
 *
 * Storage semantics, all of them from the shared split/merge:
 * - `write` upserts ONLY the keys present in the snapshot — an absent key
 *   never touches its table;
 * - `write` of a `state: null` row (a fresh establishment) clears the
 *   code's store rows, exactly what overwriting the old blob did;
 * - `read` joins the store rows back into one snapshot; a room with no
 *   rows reads `state: null`, as it always did before its first push.
 */
export function createSqliteStores(
  db: SqliteDatabase,
  now: () => number,
): (code: string) => RoomStore {
  // The core's per-store change detection (ADR-0088 §2): one decision,
  // consumed here and by the Durable Object alike. Seeded by this read
  // path below, consulted by this write path.
  const planner = createStoreWritePlanner()

  // The legacy-blob grace deadline (ADR-0088's 2026-10-14 addendum),
  // derived from the migration ledger ONCE per factory: a later migration
  // never moves an earlier stamp, so the answer cannot change within this
  // process's lifetime. 0 = no version-002 stamp (gate closed, NULL).
  const blobGraceUntil = readBlobGraceUntil(facadeOf(db), STATE_BLOB_GRACE_MS)

  const readRoomRow = (code: string): RoomSqlRow | undefined =>
    db
      .query(
        'SELECT code, rev, created_at, updated_at, last_activity, inactivity_at, serial FROM room WHERE code = ?',
      )
      .all(code)[0] as unknown as RoomSqlRow | undefined

  function readStoreRows(code: string): StoredStoreRow[] {
    // One statement per store — workerd's storage SQL rejects a compound
    // SELECT with one branch per table, and the vocabulary is short.
    return SYNCED_STORES.map((store) => ({
      store,
      text: (db.query(storeRowSql(store)).all(code)[0] as { text?: unknown } | undefined)?.text,
    })) as unknown as StoredStoreRow[]
  }

  function writeRoomRow(row: RoomRecord): void {
    // The SHARED room SQL, the same statements the Durable Object runs —
    // the schema-shaped DML is core code, not per-adapter strings (kody
    // review; ADR-0088 §4). It is an upsert, not INSERT OR REPLACE, so the
    // row keeps its `id` instead of minting a new rowid on every write.
    // `state` is the deprecated blob column: during the grace window it is
    // bound the room's MERGED snapshot (the downgrade-safety mirror — a
    // pre-per-store relay binary reading this column must keep seeing real
    // rooms), after the window NULL. The record's own `state` is only the
    // last commit's projection (an absent key is don't-touch at the shared
    // split), so the mirror joins the planner's last-known texts — the
    // post-write on-disk texts this write's plan already consulted, in the
    // SAME joinSnapshot the read path serves; no re-read, no second merge
    // to drift. Write-only: no read path touches this column.
    const known = planner.knownTexts(row.code)
    const merged =
      now() < blobGraceUntil
        ? joinSnapshot(SYNCED_STORES.map((store, index) => ({ store, text: known[index] ?? null })))
        : null
    db
      .query(ROOM_UPSERT_SQL)
      .run(
        row.code,
        row.rev,
        merged === null ? null : JSON.stringify(merged),
        row.createdAt,
        now(),
        row.lastActivityAt,
        row.deadline,
        // The retired `idle_at` column is NOT NULL on databases that
        // predate the clocks' unification — mirror the deadline, never read.
        row.deadline,
        row.serial,
      )
  }

  function writeStoreRows(row: RoomRecord): void {
    // Change detection (kody review): the core's `touch()` re-writes the
    // whole record to move the expiry clocks — without the plan, every
    // keepalive would re-upsert every synchronized store and drag each
    // `updated_at` along, contradicting "when THIS store was last
    // written" (ADR-0088 §2). Only genuinely changed rows are upserted.
    const plan = planner.plan(row.code, row.state)
    if (plan.clearAll) {
      for (const store of SYNCED_STORES) db.query(storeClearSql(store)).run(row.code)
      return
    }
    for (const { store, text } of plan.changed) {
      // `created_at` is when THIS store was first written (qodo review):
      // the room's own createdAt is the room's, not the store's — the
      // upsert preserves it on conflict, so now() is the honest stamp.
      db.query(storeUpsertSql(store)).run(row.code, text, now(), now())
    }
  }

  /**
   * A write (room row + per-store rows), a drop, and a floor write are
   * each ONE transaction (qodo review): an interruption between the room
   * upsert and its store rows must not attach one room's stores to the
   * next, and a floor write must not land half of its two rows. This is
   * the Bun half of the ADR-0088 §4 atomicity story — workerd's storage
   * SQL is per-statement atomic with no explicit BEGIN/COMMIT, which is
   * why the runner itself stays transaction-free and the adapters wrap
   * what their runtime allows.
   */
  const writeRoomAndStores = db.transaction((row: RoomRecord) => {
    // The store rows move FIRST, so the room upsert's grace mirror joins
    // the plan's post-write texts — the merged snapshot, in the same
    // transaction
    // (qodo review) so an interruption can never publish one room's
    // mirror over the next's stores.
    writeStoreRows(row)
    writeRoomRow(row)
  })
  const dropRoomAndStores = db.transaction((code: string) => {
    db.query(ROOM_DELETE_SQL).run(code)
    for (const store of SYNCED_STORES) db.query(storeClearSql(store)).run(code)
  })
  const writeFloorRecord = db.transaction((record: FloorRecord) => {
    db.query('INSERT OR REPLACE INTO rev_floor (code, rev, at) VALUES (?, ?, ?)').run(
      record.code,
      record.rev,
      record.at,
    )
    db.query('INSERT OR REPLACE INTO peer_serial (code, serial) VALUES (?, ?)').run(
      record.code,
      record.serial,
    )
  })

  return (code: string) => ({
    read: () => {
      const row = readRoomRow(code)
      if (!row) return null
      const rows = readStoreRows(code)
      // Seed change detection with what is on disk (ADR-0088 §2): the
      // first touch after a restart must not rewrite every store either.
      planner.seed(code, rows)
      return {
        code: String(row.code),
        rev: num(row.rev),
        state: joinSnapshot(rows),
        createdAt: num(row.created_at),
        lastActivityAt: num(row.last_activity),
        deadline: num(row.inactivity_at),
        serial: num(row.serial),
      } satisfies RoomRecord
    },
    write: (row) => writeRoomAndStores(row),
    drop: () => {
      dropRoomAndStores(code)
      // The room is gone; its remembered texts are dead weight (kody
      // review) — the planner stays bounded by the live room set.
      planner.forget(code)
    },
    readFloor: () => {
      const floor = db.query('SELECT code, rev, at FROM rev_floor WHERE code = ?').all(code)[0] as
        | Record<string, unknown>
        | undefined
      if (!floor) return null
      const serial = db.query('SELECT serial FROM peer_serial WHERE code = ?').all(code)[0] as
        | Record<string, unknown>
        | undefined
      return {
        code: String(floor.code),
        rev: num(floor.rev),
        at: num(floor.at),
        serial: serial ? num(serial.serial) : 0,
      } satisfies FloorRecord
    },
    writeFloor: (record) => writeFloorRecord(record),
    dropFloor: () => {
      db.query('DELETE FROM rev_floor WHERE code = ?').run(code)
      db.query('DELETE FROM peer_serial WHERE code = ?').run(code)
    },
  })
}

/**
 * The restart sweep's input (ADR-0088 §5): every persisted room's expiry
 * deadline, and every orphaned floor's prune deadline. The relay re-arms
 * timers for them at startup — without this, a room nobody rejoined would
 * never reach the clocks that are supposed to delete it.
 */
export function persistedDeadlines(
  db: SqliteDatabase,
  /** The relay's CONFIGURED room TTL — the caller's, not the default. */
  roomTtlMs: number = ROOM_TTL_MS,
): {
  rooms: { code: string; deadline: number }[]
  floors: { code: string; deadline: number }[]
} {
  const rooms = db
    .query('SELECT code, inactivity_at FROM room')
    .all()
    .map((row) => ({
      code: String(row.code),
      // The persisted deadline is read as stored: the clock the last
      // touch armed, not recomputed against today's config.
      deadline: num(row.inactivity_at),
    }))
  const floors = db
    .query('SELECT code, at FROM rev_floor')
    .all()
    .map((row) => ({ code: String(row.code), deadline: num(row.at) + roomTtlMs }))
  return { rooms, floors }
}
