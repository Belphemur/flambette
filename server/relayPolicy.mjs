/**
 * The relay's policy constants, in ONE place, with ZERO imports.
 *
 * Three consumers need these numbers and they run in three different JS
 * runtimes that cannot share an import graph:
 *
 * - `server/relay.mjs` + `server/roomLifecycle.mjs` (Bun, zero-dep, in a
 *   container that only ships `*.mjs`),
 * - `server/worker/` (workerd, where `process.env` does not exist without
 *   the `nodejs_compat` flag and `node:crypto` is not guaranteed),
 * - the vitest-pool-workers specs that drive the Durable Object.
 *
 * Keeping them here means the Bun relay and the Durable Object relay
 * cannot drift on a TTL, an alphabet or a budget — the failure mode this
 * module exists to prevent. Nothing in here may import anything: a policy
 * constant that drags a dependency in stops being shared.
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

/** The current code shape: three lowercase words (ADR-0021). */
export const WORD_CODE_RE = /^[a-z]{3,10}-[a-z]{3,10}-[a-z]{3,10}$/

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
export const PRESERVED_WHEN_ABSENT = ['cookedHistory', 'planIdentity']

/** `service` field of the relay's health payload. */
export const RELAY_SERVICE = 'mealime-relay'
