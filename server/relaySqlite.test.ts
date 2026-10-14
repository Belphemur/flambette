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
    expect(db.query('SELECT COUNT(*) AS n FROM schema_migrations').all()[0]?.n).toBe(3)
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
      expect(db.query('SELECT COUNT(*) AS n FROM schema_migrations').all()[0]?.n).toBe(3)
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

  test('orphaned floors honor the relay\'s CONFIGURED idle TTL (qodo/kody review)', () => {
    const { db, store } = freshDb()
    const registry = registryFor('c1', store('c1'))
    registry.admit('join', 0)
    registry.push(3, { plan: [1] }, 'p1')
    registry.nextSerial()
    // An operator that shortens RELAY_IDLE_TTL_MS must not wait out the
    // policy default on the floor's rows after a restart.
    const { floors } = persistedDeadlines(db, 5_000)
    expect(floors).toEqual([{ code: 'c1', deadline: 1_000_000 + 5_000 }])
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
    // first write stamps the STORE's first write — the clock the store is
    // built with, not the room's own createdAt (qodo review); the update
    // moves only updated_at.
    expect(db.query('SELECT created_at AS c, updated_at AS u FROM store_plan').all()).toEqual([
      { c: 1_000, u: 2_000 },
    ])
  })

  test('a store first written AFTER the room existed stamps its own birth (qodo review)', () => {
    const { db, stamp, store } = freshDb()
    const registry = registryFor('c1', store('c1'))
    registry.admit('join', 0) // the room is born at the registry's pinned clock
    stamp.now = 5_000
    registry.push(1, { plan: [1] }, 'p1')
    stamp.now = 6_000
    registry.push(2, { favorites: ['r1'] }, 'p1')
    expect(db.query('SELECT created_at AS c FROM store_plan').all()).toEqual([{ c: 5_000 }])
    // The favorites store appeared at ITS first write, not the room's.
    expect(db.query('SELECT created_at AS c, updated_at AS u FROM store_favorites').all()).toEqual([
      { c: 6_000, u: 6_000 },
    ])
  })

  test('a keepalive moves no store\'s updated_at — change detection (kody review)', () => {
    const { db, stamp, store } = freshDb()
    const registry = registryFor('c1', store('c1'))
    registry.admit('join', 0)
    registry.push(1, { plan: [1] }, 'p1')
    // A keepalive (and a serial mint — both touch-shaped writes) moves
    // only the ROOM row's clocks: updated_at is "when THIS store was last
    // written" (ADR-0088 §2), and no store was.
    stamp.now = 2_000
    registry.keepalive()
    registry.nextSerial()
    expect(db.query('SELECT created_at AS c, updated_at AS u FROM store_plan').all()).toEqual([
      { c: 1_000, u: 1_000 },
    ])
    // ...while the room row's own updated_at moved with the touch.
    expect(db.query('SELECT updated_at AS u FROM room WHERE code = \'c1\'').all()).toEqual([
      { u: 2_000 },
    ])
  })

  test('a real changed push still re-stamps the store it carries', () => {
    const { db, stamp, store } = freshDb()
    const registry = registryFor('c1', store('c1'))
    registry.admit('join', 0)
    registry.push(1, { plan: [1] }, 'p1')
    stamp.now = 2_000
    registry.keepalive()
    stamp.now = 3_000
    registry.push(2, { plan: [2] }, 'p1')
    expect(db.query('SELECT created_at AS c, updated_at AS u FROM store_plan').all()).toEqual([
      { c: 1_000, u: 3_000 },
    ])
  })

  test('after a RESTART the first keepalive still rewrites no store (seed from the read path)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-sqlite-'))
    const path = join(dir, 'relay.sqlite3')
    try {
      {
        const { db } = freshDb(path)
        const stores = createSqliteStores(db, () => 1_000)
        const registry = registryFor('c1', stores('c1'))
        registry.admit('join', 0)
        registry.push(1, { plan: [1] }, 'p1')
        db.close()
      }
      // Restart: a fresh process, a cold change detector.
      const { db } = freshDb(path)
      const stores = createSqliteStores(db, () => 2_000)
      const registry = registryFor('c1', stores('c1'))
      // touchIfLive reads first, so the seed is warm before the write.
      registry.keepalive()
      expect(db.query('SELECT created_at AS c, updated_at AS u FROM store_plan').all()).toEqual([
        { c: 1_000, u: 1_000 },
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a corrupt legacy state blob is skipped by the split, not a migration failure (qodo review)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-sqlite-'))
    const path = join(dir, 'relay.sqlite3')
    try {
      {
        const { db } = freshDb(path)
        // A legacy room whose blob is malformed (a truncated write from a
        // pre-ADR relay) — json_type RAISES on this text.
        db.exec(
          `INSERT INTO room (code, rev, state, created_at, updated_at, last_activity, inactivity_at, idle_at, serial)
           VALUES ('c1', 1, '{"plan":[1', 1, 1, 1, 1, 1, 1)`,
        )
        // Rewind to pre-002 so the split re-runs over the corrupt row.
        db.exec('DELETE FROM schema_migrations WHERE version = 2')
        db.close()
      }
      // "Restart": migration 002 re-runs. Without the json_valid guard
      // this open throws before the trailing UPDATE can clear the blob.
      const reopened = openRelayDatabase(path)
      try {
        expect(reopened.query('SELECT state FROM room').all()[0]?.state).toBeNull()
        expect(reopened.query('SELECT COUNT(*) AS n FROM store_plan').all()[0]?.n).toBe(0)
      } finally {
        reopened.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
