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

/** Rooms close after 24h with no keepalive and no state activity (ADR-0038, widening ADR-0026). */
export const INACTIVITY_TTL_MS = 24 * 60 * 60 * 1000

/** Backstop TTL for a room whose peers vanished without `leave`. */
export const IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000

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