/**
 * Migration 004 — per-line grocery quantity overrides become a
 * synchronized store (ADR-0100).
 *
 * Up: create `store_qty_overrides` in the shared per-store shape. The
 * table DDL is generated from the vocabulary the same way 001/003 build
 * their store tables, so the CHECK and the metadata columns cannot drift
 * from the other store tables.
 *
 * Down: drop it. The rows are one household map with no external
 * references, so the honest rollback is the whole table — there is
 * nothing to re-fold anywhere.
 */

import { storeTableName } from '../stores'
import type { MigrationStep } from '../migrations'

const TABLE = storeTableName('qtyOverrides')

export const MIGRATION_004: MigrationStep = {
  version: 4,
  name: 'grocery quantity overrides become a synchronized store (ADR-0100)',
  expects: [TABLE],
  up: [
    `
CREATE TABLE IF NOT EXISTS ${TABLE} (
  code TEXT PRIMARY KEY,
  value TEXT NOT NULL CHECK (json_valid(value)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`,
  ],
  down: [`DROP TABLE IF EXISTS ${TABLE}`],
}
