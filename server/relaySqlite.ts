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
  joinSnapshot,
  splitSnapshot,
  SYNCED_STORES,
  type StoredStoreRow,
} from './relay-core/stores'
import {
  applyMigrations,
  STORE_ROWS_SQL,
  storeClearSql,
  storeUpsertSql,
  type MigrationDatabase,
} from './relay-core/migrations'
import { IDLE_TTL_MS } from './relay-core/policy'
import type { FloorRecord, RoomRecord, RoomStore } from './relay-core/lifecycle'

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
  inactivity_at: unknown
  idle_at: unknown
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
  const readRoomRow = (code: string): RoomSqlRow | undefined =>
    db
      .query(
        'SELECT code, rev, created_at, updated_at, last_activity, inactivity_at, idle_at, serial FROM room WHERE code = ?',
      )
      .all(code)[0] as unknown as RoomSqlRow | undefined

  function readStoreRows(code: string): StoredStoreRow[] {
    // One binding per UNION branch — no numbered-parameter support assumed.
    return db
      .query(STORE_ROWS_SQL)
      .all(...SYNCED_STORES.map(() => code)) as unknown as StoredStoreRow[]
  }

  function writeRoomRow(row: RoomRecord): void {
    // `state` is the deprecated blob column: NULL from migration 002 onward,
    // never written again (ADR-0088 §2/§4).
    db
      .query(
        `INSERT OR REPLACE INTO room
         (code, rev, state, created_at, updated_at, last_activity, inactivity_at, idle_at, serial)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.code,
        row.rev,
        row.createdAt,
        now(),
        row.lastActivityAt,
        row.inactivityAt,
        row.idleAt,
        row.serial,
      )
  }

  function writeStoreRows(code: string, row: RoomRecord): void {
    const rows = splitSnapshot(row.state)
    if (!rows) {
      for (const store of SYNCED_STORES) db.query(storeClearSql(store)).run(code)
      return
    }
    for (const { store, value } of rows) {
      // `created_at` is "first write": the upsert preserves it on conflict.
      db.query(storeUpsertSql(store)).run(code, JSON.stringify(value), row.createdAt, now())
    }
  }

  return (code: string) => ({
    read: () => {
      const row = readRoomRow(code)
      if (!row) return null
      return {
        code: String(row.code),
        rev: num(row.rev),
        state: joinSnapshot(readStoreRows(code)),
        createdAt: num(row.created_at),
        lastActivityAt: num(row.last_activity),
        inactivityAt: num(row.inactivity_at),
        idleAt: num(row.idle_at),
        serial: num(row.serial),
      } satisfies RoomRecord
    },
    write: (row) => {
      writeRoomRow(row)
      writeStoreRows(code, row)
    },
    drop: () => {
      db.query('DELETE FROM room WHERE code = ?').run(code)
      for (const store of SYNCED_STORES) db.query(storeClearSql(store)).run(code)
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
    writeFloor: (record) => {
      db.query('INSERT OR REPLACE INTO rev_floor (code, rev, at) VALUES (?, ?, ?)').run(
        record.code,
        record.rev,
        record.at,
      )
      db.query('INSERT OR REPLACE INTO peer_serial (code, serial) VALUES (?, ?)').run(
        record.code,
        record.serial,
      )
    },
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
export function persistedDeadlines(db: SqliteDatabase): {
  rooms: { code: string; deadline: number }[]
  floors: { code: string; deadline: number }[]
} {
  const rooms = db
    .query('SELECT code, inactivity_at, idle_at FROM room')
    .all()
    .map((row) => ({
      code: String(row.code),
      deadline: Math.min(num(row.inactivity_at), num(row.idle_at)),
    }))
  const floors = db
    .query('SELECT code, at FROM rev_floor')
    .all()
    .map((row) => ({ code: String(row.code), deadline: num(row.at) + IDLE_TTL_MS }))
  return { rooms, floors }
}
