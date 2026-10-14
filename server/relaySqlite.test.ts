/**
 * The Bun relay's SQLite store, driven through the shared core the same
 * way the decision table drives the in-memory store (ADR-0088 §6): a real
 * `bun:sqlite` database over a `:memory:` file, plus a CLOSE-AND-REOPEN
 * pass over a temp file — the restart-survival scenario the Maps could
 * never even express, and the whole point of this change.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRoomRegistry, type RoomRegistry, type RoomStore } from './relay-core/lifecycle'
import { SYNCED_STORES, storeTableName } from './relay-core/stores'
import { createSqliteStores, openRelayDatabase, persistedDeadlines } from './relaySqlite'

/** Open + migrate a database and expose the per-code store factory. */
function freshDb(path = ':memory:', stamp = { now: 1_000 }) {
  const db = openRelayDatabase(path)
  const stores = createSqliteStores(db, () => stamp.now)
  return { db, stamp, store: (code: string) => stores(code) }
}

/** The core over a SQLite store, pinned clock, no timers needed. */
function registryFor(code: string, store: RoomStore): RoomRegistry {
  return createRoomRegistry({ code, store, now: () => 1_000_000, arm: () => {} })
}

function tableNames(db: ReturnType<typeof openRelayDatabase>): Set<string> {
  return new Set(db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row.name)))
}

describe('the Bun relay persists to SQLite (ADR-0088 §1)', () => {
  test('a fresh database opens with the migrated schema', () => {
    const { db } = freshDb()
    const tables = tableNames(db)
    expect(tables.has('room')).toBeTrue()
    for (const store of SYNCED_STORES) expect(tables.has(storeTableName(store))).toBeTrue()
    expect(db.query('SELECT COUNT(*) AS n FROM schema_migrations').all()[0]?.n).toBe(2)
  })

  test('a push stores the split rows; a read joins them back', () => {
    const { store } = freshDb()
    const registry = registryFor('c1', store('c1'))
    registry.admit('join', 0)
    registry.push(5, { plan: [1], customItems: ['milk'] }, 'p1')
    const row = store('c1').read()
    expect(row?.rev).toBe(5)
    expect(row?.state).toEqual({ plan: [1], customItems: ['milk'] })
  })

  test('a store ABSENT from a later push survives — don\'t-touch at the shared split', () => {
    const { store } = freshDb()
    const registry = registryFor('c1', store('c1'))
    registry.admit('join', 0)
    registry.push(1, { plan: [1] }, 'p1')
    registry.push(2, { customItems: ['milk'] }, 'p1')
    // The second push said nothing about `plan`; its stored row is intact.
    expect(store('c1').read()?.state).toEqual({ plan: [1], customItems: ['milk'] })
    // ...while the room row's rev moved with the latest push.
    expect(store('c1').read()?.rev).toBe(2)
  })

  test('re-establishing a room clears its store rows, as overwriting the blob did', () => {
    const { store } = freshDb()
    const registry = registryFor('c1', store('c1'))
    registry.admit('join', 0)
    registry.push(1, { plan: [1] }, 'p1')
    // An unoccupied stored room is not held against a create.
    registry.admit('create', 0)
    expect(store('c1').read()?.state).toBeNull()
  })

  test('restart survival: close and reopen — state, floor and serial all come back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-sqlite-'))
    const path = join(dir, 'relay.sqlite3')
    try {
      {
        const { db, store } = freshDb(path)
        const registry = registryFor('c1', store('c1'))
        registry.admit('join', 0)
        registry.push(7, { plan: [{ variantId: 3, servings: 2 }] }, 'p1')
        registry.nextSerial()
        registry.nextSerial()
        db.close()
      }
      // "Restart": the process is gone; a new one opens the same file.
      const { db, store } = freshDb(path)
      const registry = registryFor('c1', store('c1'))
      // The joiner adopts the STORED snapshot at the stored rev (§5).
      const verdict = registry.admit('join', 0)
      expect(verdict).toMatchObject({
        kind: 'join',
        rev: 7,
        state: { plan: [{ variantId: 3, servings: 2 }] },
        count: 1,
      })
      // The rev floor and the peer serial survived the room's closure
      // risk entirely: a re-created room cannot restart either history.
      expect(registry.floor()).toBe(7)
      expect(registry.nextSerial()).toBe(3)
      // Re-opening re-applies the migrations idempotently.
      expect(db.query('SELECT COUNT(*) AS n FROM schema_migrations').all()[0]?.n).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the startup sweep input lists every persisted room and orphaned floor', () => {
    const { db, store } = freshDb()
    const registry = registryFor('c1', store('c1'))
    registry.admit('join', 0)
    registry.push(3, { plan: [1] }, 'p1')
    registry.nextSerial()
    const { rooms, floors } = persistedDeadlines(db)
    expect(rooms).toEqual([
      { code: 'c1', deadline: Math.min(1_000_000 + 24 * 60 * 60 * 1000, 1_000_000 + 7 * 24 * 60 * 60 * 1000) },
    ])
    expect(floors).toEqual([{ code: 'c1', deadline: 1_000_000 + 7 * 24 * 60 * 60 * 1000 }])
  })

  test('store metadata is stamped: created_at is the first write, updated_at the latest', () => {
    const { db, stamp, store } = freshDb()
    const registry = registryFor('c1', store('c1'))
    registry.admit('join', 0)
    registry.push(1, { plan: [1] }, 'p1')
    stamp.now = 2_000
    registry.push(2, { plan: [2] }, 'p1')
    const row = store('c1').read()
    expect(row?.createdAt).toBe(1_000_000)
    // Per-store metadata (ADR-0088 §2): first write vs latest write. The
    // first write stamps the room's own creation; the update moves only
    // updated_at.
    expect(db.query('SELECT created_at AS c, updated_at AS u FROM store_plan').all()).toEqual([
      { c: 1_000_000, u: 2_000 },
    ])
  })
})
