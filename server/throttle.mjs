/**
 * Brute-force throttle for relay create/join (qodo 4128519648).
 *
 * Extracted from server/relay.mjs so the window/limit logic is unit
 * testable without a live socket — the CI outage on main (v0.12.0: 32
 * room specs starved by one shared-IP budget) is the regression this
 * guards against.
 *
 * Creates/joins are budgeted per socket AND per IP; ordinary state
 * fan-out between joined peers is never throttled. Plain ESM JavaScript
 * so the relay keeps running as a zero-dep Bun script.
 */

export const ATTEMPT_WINDOW_MS = 60_000

/** Default create/join budget per socket/IP per window (env-tunable). */
export const DEFAULT_ATTEMPT_LIMIT = Number(process.env.RELAY_ATTEMPT_LIMIT ?? 30)

/** Simple Map-backed bucket store (swap for a fake in tests). */
export class MemoryAttemptBuckets {
  #map = new Map()

  get(key) {
    return this.#map.get(key)
  }
  set(key, value) {
    this.#map.set(key, value)
  }
  delete(key) {
    this.#map.delete(key)
  }
  get size() {
    return this.#map.size
  }
  entries() {
    return this.#map.entries()
  }
  clear() {
    this.#map.clear()
  }
}

/**
 * Build a throttle. Everything is injectable so tests can pin the clock,
 * the limit and the peer address without opening sockets.
 */
export function makeThrottle({
  limit = DEFAULT_ATTEMPT_LIMIT,
  windowMs = ATTEMPT_WINDOW_MS,
  buckets = new MemoryAttemptBuckets(),
  now = () => Date.now(),
  peerAddress = () => 'unknown',
} = {}) {
  /** Address lookup that never throws (Bun's requestIP rejects a
   *  ServerWebSocket with "Expected Request object" — an uncaught
   *  TypeError there kills the message handler before any reply is
   *  sent, and rooms hang forever in "connecting". Degrading to
   *  'unknown' falls back to the shared-IP budget, which is strictly
   *  MORE conservative than skipping the IP check. */
  function safeAddress(ws) {
    try {
      return peerAddress(ws) ?? 'unknown'
    } catch {
      return 'unknown'
    }
  }
  /**
   * One create/join attempt against BOTH the per-socket and per-IP
   * budgets. True when the attempt may proceed.
   */
  function allow(ws) {
    const t = now()
    const keys = [`sock:${ws.data.peerId}`, `ip:${safeAddress(ws)}`]
    for (const key of keys) {
      const bucket = buckets.get(key)
      if (!bucket || t - bucket.start > windowMs) {
        buckets.set(key, { start: t, count: 1 })
      } else if (bucket.count >= limit) {
        return false
      } else {
        bucket.count += 1
      }
    }
    // Occasional prune so the map cannot grow without bound.
    if (buckets.size > 4096) {
      for (const [key, bucket] of buckets.entries()) {
        if (t - bucket.start > windowMs) buckets.delete(key)
      }
    }
    return true
  }

  return { allow, limit, windowMs }
}
