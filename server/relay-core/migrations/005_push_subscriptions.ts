/**
 * Migration 005 — server-side Web Push subscriptions (ADR-0102).
 *
 * The relay becomes a push SENDER, which needs the household's
 * subscription rows persisted across restarts: a phone whose browser is
 * closed is exactly the member the feature exists to reach, so the row
 * must outlive the process (ADR-0088's storage philosophy applied to the
 * new state). NOT a synchronized store: subscriptions never ride the
 * room-sync payload — this table is server-owned, keyed
 * (room code, subscription endpoint).
 *
 * Up: one table, the per-store row shape without the `value` vocabulary —
 * `keys` is the JSON `{p256dh, auth}` blob (json_valid CHECK, like every
 * JSON TEXT column in this schema).
 *
 * Down: drop it. The rows are device state with no external references,
 * so the honest rollback is the whole table — devices re-register on
 * their next room join.
 */

export const PUSH_SUBSCRIPTIONS_TABLE = 'push_subscriptions'

export const MIGRATION_005 = {
  version: 5,
  name: 'server-side Web Push subscriptions (ADR-0102)',
  expects: [PUSH_SUBSCRIPTIONS_TABLE],
  up: [
    `
CREATE TABLE IF NOT EXISTS ${PUSH_SUBSCRIPTIONS_TABLE} (
  code TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  keys TEXT NOT NULL CHECK (json_valid(keys)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (code, endpoint)
)`,
  ],
  down: [`DROP TABLE IF EXISTS ${PUSH_SUBSCRIPTIONS_TABLE}`],
} as const
