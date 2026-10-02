/**
 * Brute-force throttle for relay create/join (qodo 4128519648).
 *
 * The window/limit arithmetic lives in ./throttleCore.mjs so the Cloudflare
 * Durable Object relay can run the SAME code without dragging this
 * module's module-scope `process.env` read into workerd. This file is the
 * Bun/Node-facing wrapper: it is what server/relay.mjs imports, and it is
 * the only place the env-tunable default is applied.
 */

import {
  ATTEMPT_WINDOW_MS as CORE_WINDOW_MS,
  makeThrottle as makeCoreThrottle,
  MemoryAttemptBuckets,
} from './throttleCore.mjs'
import { DEFAULT_ATTEMPT_LIMIT as CORE_ATTEMPT_LIMIT } from './relayPolicy.mjs'

export { MemoryAttemptBuckets }

/** Fixed window the attempt budget is measured over. */
export const ATTEMPT_WINDOW_MS = CORE_WINDOW_MS

/**
 * Default create/join budget per socket/IP per window (env-tunable — the
 * e2e suite raises it so a shared CI IP never starves a spec).
 */
export const DEFAULT_ATTEMPT_LIMIT = Number(process.env.RELAY_ATTEMPT_LIMIT ?? CORE_ATTEMPT_LIMIT)

/**
 * Build a throttle, defaulting the limit to the env-tunable value. All
 * arguments pass straight through to the shared core.
 */
export function makeThrottle(options = {}) {
  return makeCoreThrottle({ limit: DEFAULT_ATTEMPT_LIMIT, ...options })
}
