/**
 * The relay's policy constants, in ONE place, with ZERO imports.
 *
 * Consumers run in JS runtimes that cannot share an import graph:
 *
 * - `server/relay.ts` (Bun, zero-dep, in a container that only ships the
 *   relay's own files),
 * - `server/worker/` (workerd, where `process.env` does not exist without
 *   the `nodejs_compat` flag and `node:crypto` is not guaranteed),
 * - the decision-table specs that drive the shared core.
 *
 * Keeping them here means the two relays cannot drift on a TTL, an
 * alphabet or a budget — the failure mode this module exists to prevent.
 * Nothing in here may import anything: a policy constant that drags a
 * dependency in stops being shared (ADR-0040, promoting the former
 * `server/relayPolicy.mjs`).
 */

/**
 * The ONE room-retention window: a room is deleted after 30 days with no
 * keepalive and no state activity (ADR-0038's 2026-10-14 addendum,
 * widening ADR-0026). The pre-collapse design carried a SECOND clock — a
 * 7-day "idle backstop" whose deletion deadline was the earlier of the
 * two — but once both clocks widened to the same 30 days the pair had
 * nothing left to separate: two identical stamps, a no-op `min()`, and an
 * expiry reason (`idle`) that could never fire. One room clock now
 * governs deletion AND the rev floor's age-out (the floor keeps its own
 * timestamp; its prune deadline is `floor.at + ROOM_TTL_MS`).
 */
export const ROOM_TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * How long the relay keeps MIRRORING the deprecated `room.state` blob
 * after the per-store split migrated it (ADR-0088's 2026-10-14 addendum).
 *
 * A pre-per-store relay binary — or any old reader of the blob — running
 * against a migrated database would see EMPTY rooms once the blob is
 * nulled: silent data loss on a downgrade. For one grace window after
 * migration 002 applies, every room upsert re-binds the record's merged
 * snapshot into the blob column so an old binary keeps serving real data;
 * after the window the upsert binds NULL again (the blob a room last
 * mirrored simply stays — write-only, never read by the new binary).
 *
 * One room-TTL window (the same 30 days as ROOM_TTL_MS), symmetric with
 * the floor's post-expiry retention story. NOT an env override on
 * purpose: the grace deadline is derived from the migration ledger
 * (`readBlobGraceUntil`), so both runtimes agree without configuration —
 * this constant is the window, the same on a Bun relay and a Durable
 * Object.
 */
export const STATE_BLOB_GRACE_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Legacy relay-minted room codes: Crockford base32 with every vowel
 * removed, so a code never spells a word. Word codes (ADR-0021) are
 * rolled client-side; this shape only exists for a `create` that arrived
 * without one.
 */
export const CODE_ALPHABET = '0123456789BCDFGHJKLMNPQRSTVWXZ'
export const CODE_LENGTH = 6

/**
 * Create/join budget per socket AND per IP, per window. Only create/join
 * spend it — keepalive and state fan-out never do.
 */
export const DEFAULT_ATTEMPT_LIMIT = 30

/** Fixed window the attempt budget is measured over. */
export const ATTEMPT_WINDOW_MS = 60_000

/**
 * Parse a numeric env/var override, falling back when it is absent or
 * nonsense. The e2e suite shrinks the TTLs to exercise expiry in
 * milliseconds, so a typo'd value must not become `NaN` and close every
 * room instantly. Both adapters feed their raw environment string into
 * this ONE parser — the Bun relay's `process.env` and the worker's vars
 * binding are the same untrusted `string | undefined`.
 */
export function parsePositiveNumber(raw: string | undefined | null, fallback: number): number {
  if (raw === undefined || raw === null) return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * The health payload BOTH relays answer a plain GET with, shaped once so
 * the keys cannot drift (tests assert them). The VALUES stay
 * adapter-resolved — only the adapter knows its own live TTL overrides
 * and throttle limit.
 */
export function healthPayload(config: {
  roomTtlMs: number
  attemptLimit: number
}): {
  service: typeof RELAY_SERVICE
  roomTtlMs: number
  attemptLimit: number
} {
  return { service: RELAY_SERVICE, ...config }
}

/**
 * Shared-state members that are PRESERVED when an inbound snapshot omits
 * them (ADR-0028's "absent means don't touch", made per key because
 * `planIdentity` is explicitly nullable — ADR-0034).
 *
 * - `cookedHistory`: an opted-out sender is silent about history, never
 *   a wipe (ADR-0032).
 * - `planIdentity`: `null` is a real answer and replaces; absent is a peer
 *   on older code and carries forward.
 */
export const PRESERVED_WHEN_ABSENT = ['cookedHistory', 'planIdentity'] as const

/** `service` field of the relay's health payload. */
export const RELAY_SERVICE = 'mealime-relay'