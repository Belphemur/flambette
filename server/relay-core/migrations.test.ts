/**
 * The migration runner's ledger semantics (ADR-0088 §4), against a real
 * in-memory SQLite database: what is pending is decided from the recorded
 * version, and a `down` step runs ONLY through the explicit `rollbackTo`
 * entry point — never as a side effect of applying forward.
 *
 * The step SQL itself (001/002, fresh and legacy shapes) is exercised in
 * `stores.test.ts`; the workerd side of the same steps in
 * `worker/room.test.ts`.
 */

import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { applyMigrations, rollbackTo, storeUpsertSql, type MigrationDatabase } from './migrations'
import { storeTableName } from './stores'

/** The facade over `bun:sqlite` — the shape the Bun adapter actually runs. */
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

function ledger(db: MigrationDatabase): Record<string, unknown>[] {
  return db.all('SELECT version, applied_at FROM schema_migrations ORDER BY version')
}

describe('pending detection from the recorded version (ADR-0088 §4)', () => {
  test('a fresh database runs every step and records each', () => {
    const db = bunDb()
    applyMigrations(db, () => 1_000)
    expect(ledger(db).map((r) => Number(r.version))).toEqual([1, 2, 3, 4])
    db.close()
  })

  test('a current database runs nothing: stamps survive untouched', () => {
    const db = bunDb()
    applyMigrations(db, () => 1_000)
    const before = ledger(db)
    applyMigrations(db, () => 2_000)
    expect(ledger(db)).toEqual(before)
    db.close()
  })

  test('a partial database runs only the tail: the recorded prefix stays put', () => {
    const db = bunDb()
    // Simulate a database stopped mid-upgrade: 001 recorded, 002/003 not.
    applyMigrations(db, () => 1_000)
    db.exec('DELETE FROM schema_migrations WHERE version >= 2')
    // ...and drop one of 002's effects to prove the tail re-runs it.
    db.exec('UPDATE room SET state = NULL WHERE state IS NOT NULL')
    db.exec(
      `INSERT INTO room (code, rev, created_at, updated_at, last_activity, inactivity_at, idle_at, serial)
       VALUES ('C1', 1, 1, 1, 1, 1, 1, 0)`,
    )
    db.exec(`UPDATE room SET state = '{"plan":[9]}' WHERE code = 'C1'`)

    applyMigrations(db, () => 2_000)
    // Only the tail was re-applied: the version-1 stamp is the ORIGINAL one.
    expect(ledger(db)).toEqual([
      { version: 1, applied_at: 1_000 },
      { version: 2, applied_at: 2_000 },
      { version: 3, applied_at: 2_000 },
      { version: 4, applied_at: 2_000 },
    ])
    // ...and the pending tail did its work: the blob was split into rows.
    const row = db.all('SELECT value FROM store_plan WHERE code = ? OR code = ?', 'c1', 'C1')
    expect(JSON.parse(String(row[0]?.value))).toEqual([9])
    db.close()
  })
})

describe('migration 003 — the pantry becomes a synchronized store (ADR-0090)', () => {
  test('store_pantry carries the shared per-store shape, CHECK included', () => {
    const db = bunDb()
    applyMigrations(db, () => 1_000)
    db.exec(
      storeUpsertSql('pantry'),
      'c1',
      JSON.stringify([{ name: 'Butter', nameKey: 'butter' }]),
      100,
      100,
    )
    expect(() => db.exec(storeUpsertSql('pantry'), 'c1', 'not json', 1, 1)).toThrow(
      /CHECK constraint failed/,
    )
    db.close()
  })

  test('rolling back to version 2 drops store_pantry — the version-2 world has no pantry', () => {
    const db = bunDb()
    applyMigrations(db, () => 1_000)
    db.exec(storeUpsertSql('pantry'), 'c1', '[{"name":"Butter","nameKey":"butter"}]', 100, 100)

    rollbackTo(db, 2)
    expect(ledger(db).map((r) => Number(r.version))).toEqual([1, 2])
    const objects = db
      .all("SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((row) => String(row.name))
    expect(objects).not.toContain(storeTableName('pantry'))
    db.close()
  })
})

describe('the explicit rollback entry point (down runs ONLY here)', () => {
  test('rollbackTo one version re-folds per-store rows into the legacy blob', () => {
    const db = bunDb()
    applyMigrations(db, () => 1_000)
    db.exec(storeUpsertSql('plan'), 'c1', '[1,2]', 100, 100)
    db.exec(storeUpsertSql('checked'), 'c1', '{"a|b":true}', 100, 100)
    db.exec(
      `INSERT INTO room (code, rev, created_at, updated_at, last_activity, inactivity_at, idle_at, serial)
       VALUES ('c1', 1, 100, 100, 100, 100, 100, 0)`,
    )

    rollbackTo(db, 1)
    // The ledger no longer records 002…
    expect(ledger(db).map((r) => Number(r.version))).toEqual([1])
    // …and its effect is reversed: the rows are back under the blob keys.
    const blob = db.all('SELECT state FROM room WHERE code = ?', 'c1')[0]
    const parsed = JSON.parse(String(blob.state))
    expect(parsed.plan).toEqual([1, 2])
    expect(parsed.checked).toEqual({ 'a|b': true })
    db.close()
  })

  test('rollbackTo zero drops every schema object and empties the ledger', () => {
    const db = bunDb()
    applyMigrations(db, () => 1_000)
    db.exec(storeUpsertSql('plan'), 'c1', '[1]', 100, 100)

    rollbackTo(db, 0)
    // The LEDGER table survives (the runner owns it; it predates step 1) —
    // but it is empty, and no schema object a step created remains.
    const objects = db
      .all("SELECT name FROM sqlite_master WHERE type IN ('table', 'index')")
      .map((row) => String(row.name))
      .filter((name) => name !== 'schema_migrations' && !name.startsWith('sqlite_'))
    expect(objects).toEqual([])
    expect(ledger(db)).toEqual([])
    db.close()
  })

  test('a rolled-back database converges: the next apply re-runs the tail', () => {
    const db = bunDb()
    applyMigrations(db, () => 1_000)
    db.exec(storeUpsertSql('plan'), 'c1', '[1,2]', 100, 100)
    db.exec(
      `INSERT INTO room (code, rev, created_at, updated_at, last_activity, inactivity_at, idle_at, serial)
       VALUES ('c1', 1, 100, 100, 100, 100, 100, 0)`,
    )
    rollbackTo(db, 1)

    applyMigrations(db, () => 2_000)
    expect(ledger(db).map((r) => Number(r.version))).toEqual([1, 2, 3, 4])
    // 002's INSERT OR IGNORE re-inserts nothing over the surviving rows;
    // the fold (rollback) left a valid JSON blob and the re-apply's split
    // keeps it — the grace mirror's POST-migration shape (ADR-0088's
    // 2026-10-14 addendum), still carrying the folded plan for old readers.
    expect(db.all('SELECT value FROM store_plan WHERE code = ?', 'c1')).toEqual([
      { value: '[1,2]' },
    ])
    expect(db.all('SELECT state FROM room WHERE code = ?', 'c1')[0].state).toBe('{"plan":[1,2]}')
    db.close()
  })
})