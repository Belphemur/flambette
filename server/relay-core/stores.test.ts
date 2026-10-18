/**
 * The per-store storage vocabulary and the shared migration runner
 * (ADR-0088 §1/§2/§4/§6), against a real in-memory SQLite database — the
 * same engine the Bun adapter runs, so the SQL statements and the
 * `json_*` behaviour the runner relies on are exercised for real here.
 * The workerd side of the same steps is proven in `worker/room.test.ts`.
 */

import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { SHARED_STATE_KEYS } from '../../src/lib/roomSyncStores'
import {
  SYNCED_STORES,
  createStoreWritePlanner,
  joinSnapshot,
  splitSnapshot,
  storeTableName,
  type SyncedStore,
} from './stores'
import {
  MIGRATIONS,
  applyMigrations,
  storeClearSql,
  storeRowSql,
  storeUpsertSql,
  type MigrationDatabase,
} from './migrations'

/* ---------------------------------------------------------------- helpers */

/**
 * The facade over `bun:sqlite` — the same mapping the Bun adapter uses,
 * so the specs exercise the runner through the shape it actually runs.
 */
function bunDb(path = ':memory:'): MigrationDatabase & { close: () => void } {
  const db = new Database(path)
  return {
    exec: (sql, ...bindings) => {
      if (bindings.length > 0) db.query(sql).run(...bindings)
      else db.exec(sql)
    },
    all: (sql, ...bindings) =>
      db.query(sql).all(...bindings) as unknown as Record<string, unknown>[],
    close: () => db.close(),
  }
}

function tableNames(db: MigrationDatabase): Set<string> {
  return new Set(
    db
      .all("SELECT name FROM sqlite_master WHERE type IN ('table', 'index')")
      .map((row) => String(row.name)),
  )
}

function storeRowCount(db: MigrationDatabase, store: SyncedStore): number {
  const row = db.all(`SELECT COUNT(*) AS n FROM ${storeTableName(store)}`)[0]
  return Number(row?.n)
}

/* ------------------------------------------------------------- vocabulary */

describe('the store vocabulary (ADR-0088 §2/§6)', () => {
  test('SYNCED_STORES and the client SharedState keys AGREE — the cross-check gate', () => {
    // The failure this gate exists for: a store added to one side and not
    // the other is silently dropped from per-store STORAGE (and, if a
    // table is missing, crashes at write time). Drift must be loud.
    expect([...SYNCED_STORES]).toEqual([...SHARED_STATE_KEYS])
  })

  test('every store maps to a DISTINCT snake_case table name', () => {
    const names = SYNCED_STORES.map(storeTableName)
    expect(new Set(names).size).toBe(SYNCED_STORES.length)
    // Digits are legal in a SQLite identifier's tail (store_cleared_v2,
    // ADR-0094's wire-versioned cleared spelling) — the store_ prefix
    // guarantees the leading character is a letter either way.
    for (const name of names) expect(name).toMatch(/^store_[a-z0-9_]+$/)
  })

  test('the ADR-0088 table spellings are kept', () => {
    expect(storeTableName('plan')).toBe('store_plan')
    expect(storeTableName('customItems')).toBe('store_custom_items')
    expect(storeTableName('cookedHistory')).toBe('store_cooked_history')
    expect(storeTableName('favorites')).toBe('store_favorites')
    expect(storeTableName('ratingTombstones')).toBe('store_rating_tombstones')
    expect(storeTableName('planIdentity')).toBe('store_plan_identity')
  })
})

/* ----------------------------------------------------------- split / join */

describe('splitSnapshot — absence is don\'t-touch, at the shared split', () => {
  test('only the keys present in the payload become rows', () => {
    const rows = splitSnapshot({ plan: [1], checked: { a: true } })
    expect(rows).toEqual([
      { store: 'plan', value: [1] },
      { store: 'checked', value: { a: true } },
    ])
  })

  test('an explicit null is PRESENT — planIdentity: null is an answer (ADR-0034)', () => {
    const rows = splitSnapshot({ planIdentity: null })
    expect(rows).toEqual([{ store: 'planIdentity', value: null }])
  })

  test('an absent key is silence, never a wipe; unknown keys are not stored', () => {
    const rows = splitSnapshot({ futureStore: { x: 1 } } as Record<string, unknown>)
    expect(rows).toEqual([])
  })

  test('a null/absent snapshot splits to nothing (a fresh room stores no rows)', () => {
    expect(splitSnapshot(null)).toBeNull()
    expect(splitSnapshot(undefined)).toBeNull()
  })
})

describe('joinSnapshot — the single snapshot a joined/fan-out needs', () => {
  test('round-trips the rows a split produced', () => {
    const state = {
      plan: [{ variantId: 7, servings: 2 }],
      planIdentity: null,
      favorites: { '12': { favorited: true, updatedAt: 5 } },
    }
    const rows = splitSnapshot(state)!
    const stored = rows.map((row) => ({ store: row.store, text: JSON.stringify(row.value) }))
    expect(joinSnapshot(stored)).toEqual(state)
  })

  test('an unparseable row is skipped, not fatal — a corrupt store must not kill the room', () => {
    const snapshot = joinSnapshot([
      { store: 'plan', text: 'not json' },
      { store: 'checked', text: '{"a":true}' },
    ])
    expect(snapshot).toEqual({ checked: { a: true } })
  })

  test('unknown stores and null columns are skipped; no rows reads as null', () => {
    expect(joinSnapshot([{ store: 'fromTheFuture', text: '{}' }])).toBeNull()
    expect(joinSnapshot([{ store: 'plan', text: null }])).toBeNull()
    expect(joinSnapshot([])).toBeNull()
  })

  test("the JSON 'null' store value parses back as a present null", () => {
    expect(joinSnapshot([{ store: 'planIdentity', text: 'null' }])).toEqual({ planIdentity: null })
  })
})

/* -------------------------------------------------------- write planning */

describe('createStoreWritePlanner — a touch must not rewrite unchanged stores', () => {
  test('an unseeded store text defaults to WRITE IT — the safe superset', () => {
    const planner = createStoreWritePlanner()
    const plan = planner.plan('c1', { plan: [1] })
    expect(plan.clearAll).toBe(false)
    expect(plan.changed).toEqual([{ store: 'plan', text: '[1]' }])
  })

  test('an unchanged text is not re-upserted; a changed one is', () => {
    const planner = createStoreWritePlanner()
    planner.plan('c1', { plan: [1], favorites: { a: 1 } })
    // The touch-shaped rewrite: same values, nothing moves.
    expect(planner.plan('c1', { plan: [1], favorites: { a: 1 } }).changed).toEqual([])
    // One store changed: only that one is planned.
    expect(planner.plan('c1', { plan: [2], favorites: { a: 1 } }).changed).toEqual([
      { store: 'plan', text: '[2]' },
    ])
    // A store ABSENT from the write stays don't-touch (existing split rule).
    expect(planner.plan('c1', { plan: [2] }).changed).toEqual([])
  })

  test('seeding from the read path warms the planner — restarts do not rewrite', () => {
    const planner = createStoreWritePlanner()
    planner.seed('c1', [
      { store: 'plan', text: '[1]' },
      { store: 'favorites', text: null },
      { store: 'fromTheFuture', text: '{}' },
    ])
    // The stored text already matches what a write would serialize.
    expect(planner.plan('c1', { plan: [1] }).changed).toEqual([])
    // A store the room never carried reads as null; writing a value for
    // it is a change.
    expect(planner.plan('c1', { favorites: { b: 2 } }).changed).toEqual([
      { store: 'favorites', text: '{"b":2}' },
    ])
  })

  test('a `state: null` write plans clearAll and forgets the texts', () => {
    const planner = createStoreWritePlanner()
    planner.plan('c1', { plan: [1] })
    const plan = planner.plan('c1', null)
    expect(plan).toEqual({ changed: [], clearAll: true })
    // After the clear the planner knows the rows are gone: writing the
    // same value again is a change (a fresh first write), not a skip.
    expect(planner.plan('c1', { plan: [1] }).changed).toEqual([{ store: 'plan', text: '[1]' }])
  })

  test('codes are tracked independently', () => {
    const planner = createStoreWritePlanner()
    planner.plan('c1', { plan: [1] })
    expect(planner.plan('c2', { plan: [1] }).changed).toEqual([{ store: 'plan', text: '[1]' }])
  })

  test('knownTexts reports the post-write texts in SYNCED_STORES order — the grace mirror\'s join input', () => {
    const planner = createStoreWritePlanner()
    planner.seed('c1', [
      { store: 'plan', text: '[1,2]' },
      { store: 'customItems', text: null },
    ])
    // A push carrying only `plan`: the plan advances `plan`'s text and
    // leaves `customItems` at its seeded (on-disk) value — exactly what
    // the tables hold once the changed rows are written.
    planner.plan('c1', { plan: [3] })
    const texts = planner.knownTexts('c1')
    expect(texts[SYNCED_STORES.indexOf('plan')]).toBe('[3]')
    expect(texts[SYNCED_STORES.indexOf('customItems')]).toBeNull()
    // An unseen code reads as all-null (the read-before-write invariant
    // keeps this from ever reaching the mirror on a real write path).
    expect(planner.knownTexts('c9').every((text) => text === null)).toBeTrue()
  })

  test('forget reclaims a dropped room\'s entries — the memory is bounded by the live set', () => {
    const planner = createStoreWritePlanner()
    planner.plan('c1', { plan: [1] })
    planner.forget('c1')
    // A forgotten code writes conservatively again — a room with the same
    // code can only exist after a fresh establishment anyway.
    expect(planner.plan('c1', { plan: [1] }).changed).toEqual([{ store: 'plan', text: '[1]' }])
  })
})

/* ----------------------------------------------------------------- runner */

describe('the migration runner (ADR-0088 §4) over a real in-memory SQLite', () => {
  test('a fresh database gets the full schema, recorded in the ledger', () => {
    const db = bunDb()
    applyMigrations(db, () => 1_000)
    const tables = tableNames(db)
    expect(tables.has('room')).toBeTrue()
    expect(tables.has('room_code_idx')).toBeTrue()
    expect(tables.has('rev_floor')).toBeTrue()
    expect(tables.has('peer_serial')).toBeTrue()
    expect(tables.has('schema_migrations')).toBeTrue()
    for (const store of SYNCED_STORES) expect(tables.has(storeTableName(store))).toBeTrue()
    expect(db.all('SELECT version, name FROM schema_migrations ORDER BY version')).toEqual([
      { version: 1, name: 'per-store base schema' },
      { version: 2, name: 'split room state blobs into per-store rows' },
      { version: 3, name: 'the pantry becomes a synchronized store' },
    ])
    db.close()
  })

  test('re-applying is idempotent: no error, no new ledger rows, stamps preserved', () => {
    const db = bunDb()
    applyMigrations(db, () => 1_000)
    const before = db.all('SELECT version, applied_at FROM schema_migrations ORDER BY version')
    applyMigrations(db, () => 2_000)
    expect(db.all('SELECT version, applied_at FROM schema_migrations ORDER BY version')).toEqual(
      before,
    )
    db.close()
  })

  test('the ledger claims nothing the database does not show: a rolled-back table is re-created', () => {
    const db = bunDb()
    applyMigrations(db, () => 1_000)
    db.exec('DROP TABLE store_ratings')
    // The ledger records version 1, but its `expects` no longer hold — the
    // runner must re-apply instead of trusting the stamp (the DO can be
    // evicted and a test's storage rolled back under it).
    applyMigrations(db, () => 2_000)
    expect(tableNames(db).has('store_ratings')).toBeTrue()
    db.close()
  })

  test('the json_valid CHECK makes a corrupt write fail AT WRITE TIME', () => {
    const db = bunDb()
    applyMigrations(db, () => 1_000)
    expect(() =>
      db.exec(storeUpsertSql('plan'), 'c1', 'not json', 1, 1),
    ).toThrow(/CHECK constraint failed/)
    db.close()
  })

  test('the shared row SQL round-trips: upsert, created_at survives update, read, clear', () => {
    const db = bunDb()
    applyMigrations(db, () => 1_000)
    db.exec(storeUpsertSql('plan'), 'c1', '[1,2]', 100, 100)
    db.exec(storeUpsertSql('plan'), 'c1', '[3]', 200, 200)
    expect(storeRowCount(db, 'plan')).toBe(1)
    const rows = db.all(storeRowSql('plan'), 'c1')
    expect(rows).toEqual([{ text: '[3]' }])
    db.exec(storeClearSql('plan'), 'c1')
    expect(storeRowCount(db, 'plan')).toBe(0)
    db.close()
  })

  test('storeRowSql returns the raw JSON text of one store, aliased as text', () => {
    expect(storeRowSql('plan')).toBe('SELECT value AS text FROM store_plan WHERE code = ?')
    expect(storeRowSql('customItems')).toContain('store_custom_items')
  })
})

describe('migration 002 splits the DO legacy blobs (ADR-0088 §4)', () => {
  /** A database in the shape the Durable Object shipped before ADR-0088. */
  function legacyDb(): MigrationDatabase & { close: () => void } {
    const db = bunDb()
    db.exec(`
      CREATE TABLE room (
        id INTEGER PRIMARY KEY,
        code TEXT NOT NULL,
        rev INTEGER NOT NULL,
        state TEXT,
        created_at INTEGER NOT NULL,
        last_activity INTEGER NOT NULL,
        inactivity_at INTEGER NOT NULL,
        idle_at INTEGER NOT NULL,
        serial INTEGER NOT NULL
      );
      CREATE TABLE rev_floor (code TEXT PRIMARY KEY, rev INTEGER NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE peer_serial (code TEXT PRIMARY KEY, serial INTEGER NOT NULL);
    `)
    return db
  }

  test('per-store rows appear, a valid blob SURVIVES the split, updated_at is added and backfilled', () => {
    const db = legacyDb()
    const blob = JSON.stringify({
      plan: [{ variantId: 9, servings: 4 }],
      checked: { '12|butter': true },
      planIdentity: null,
      favorites: { '3': { favorited: true, updatedAt: 42 } },
    })
    db.exec(
      `INSERT INTO room (id, code, rev, state, created_at, last_activity, inactivity_at, idle_at, serial)
       VALUES (1, 'amber-falcon-lantern', 5, ?, 111, 222, 333, 444, 2)`,
      blob,
    )
    db.exec(`INSERT INTO rev_floor (code, rev, at) VALUES ('amber-falcon-lantern', 5, 222)`)
    db.exec(`INSERT INTO peer_serial (code, serial) VALUES ('amber-falcon-lantern', 2)`)

    applyMigrations(db, () => 1_000)

    expect(storeRowCount(db, 'plan')).toBe(1)
    expect(storeRowCount(db, 'checked')).toBe(1)
    expect(storeRowCount(db, 'planIdentity')).toBe(1)
    expect(storeRowCount(db, 'favorites')).toBe(1)
    // A key the blob did not carry inserted NO row.
    expect(storeRowCount(db, 'ratings')).toBe(0)
    expect(storeRowCount(db, 'customItems')).toBe(0)

    // A valid blob SURVIVES the split — the original text, verbatim (the
    // grace mirror, ADR-0088's 2026-10-14 addendum): old readers of this
    // column keep seeing the room through the grace window. Only a blob
    // that is not json_valid is nulled.
    expect(db.all('SELECT state FROM room')[0]?.state).toBe(blob)
    // The guarded ALTER backfilled the new metadata column.
    expect(db.all('SELECT updated_at FROM room')[0]?.updated_at).toBe(222)
    // The floor/serial tables the legacy database already had are untouched.
    expect(db.all('SELECT * FROM rev_floor')).toHaveLength(1)
    expect(db.all('SELECT * FROM peer_serial')).toHaveLength(1)

    // The split is the round-trip: joining the rows reads back the blob.
    const code = 'amber-falcon-lantern'
    const rows = SYNCED_STORES.map((store) => ({
      store,
      text: (db.all(storeRowSql(store), code)[0] as { text?: unknown } | undefined)?.text,
    }))
    expect(joinSnapshot(rows as never)).toEqual(JSON.parse(blob))
    db.close()
  })

  test('a blob without a key inserts no row for it; re-applying the split is a no-op', () => {
    const db = legacyDb()
    db.exec(
      `INSERT INTO room (id, code, rev, state, created_at, last_activity, inactivity_at, idle_at, serial)
       VALUES (1, 'c1', 1, ?, 10, 20, 30, 40, 0)`,
      JSON.stringify({ plan: [1] }),
    )
    applyMigrations(db, () => 1_000)
    expect(storeRowCount(db, 'plan')).toBe(1)
    expect(storeRowCount(db, 'planIdentity')).toBe(0)

    const after = db.all('SELECT version, applied_at FROM schema_migrations ORDER BY version')
    const planRows = db.all(`SELECT * FROM ${storeTableName('plan')}`)
    applyMigrations(db, () => 2_000)
    expect(db.all('SELECT version, applied_at FROM schema_migrations ORDER BY version')).toEqual(
      after,
    )
    expect(db.all(`SELECT * FROM ${storeTableName('plan')}`)).toEqual(planRows)
    db.close()
  })

  test('a blob whose planIdentity is a real object survives as JSON text', () => {
    const db = legacyDb()
    db.exec(
      `INSERT INTO room (id, code, rev, state, created_at, last_activity, inactivity_at, idle_at, serial)
       VALUES (1, 'c1', 1, ?, 10, 20, 30, 40, 0)`,
      JSON.stringify({ planIdentity: { planId: 'p1', planCreatedAt: 7 } }),
    )
    applyMigrations(db, () => 1_000)
    expect(db.all(`SELECT value FROM ${storeTableName('planIdentity')}`)).toEqual([
      { value: '{"planId":"p1","planCreatedAt":7}' },
    ])
    db.close()
  })

  test('the runner is ascending and append-only (never renumber a shipped step)', () => {
    expect(MIGRATIONS.map((step) => step.version)).toEqual([1, 2, 3])
  })
})
