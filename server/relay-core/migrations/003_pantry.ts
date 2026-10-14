/**
 * Migration 003 — the pantry becomes a synchronized store (ADR-0087
 * Decision 7 SUPERSEDED: device-local → household, the same 2026 policy
 * change ADR-0012 applied to custom ingredients).
 *
 * Up: create `store_pantry` in the shared per-store shape. The table DDL
 * is generated from the vocabulary the same way migration 001 builds its
 * store tables, so the CHECK and the metadata columns cannot drift from
 * the other store tables.
 *
 * Down: drop it. The store's rows are household data in one table with no
 * external references, so the honest rollback is the whole table — there
 * is nothing to re-fold anywhere.
 */

import { storeTableName } from '../stores'
import type { MigrationStep } from '../migrations'

const TABLE = storeTableName('pantry')

export const MIGRATION_003: MigrationStep = {
  version: 3,
  name: 'the pantry becomes a synchronized store',
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