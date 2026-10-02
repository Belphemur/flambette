/**
 * Brute-force throttle core: the window/limit arithmetic, with no runtime
 * assumptions at all.
 *
 * It used to live inside `throttle.mjs`, which read
 * `process.env.RELAY_ATTEMPT_LIMIT` at module scope. That read is fine
 * under Bun and fatal in workerd (no `process` without
 * `nodejs_compat`), so importing the module into the Cloudflare worker
 * graph would have thrown before the worker's first line ran. Splitting
 * the arithmetic out lets BOTH runtimes share ONE implementation instead
 * of keeping a hand-copied second one in sync.
 *
 * `throttle.mjs` is the Bun/Node-facing wrapper that layers the env-tunable
 * default on top; the worker imports this file directly and passes its
 * limit explicitly.
 */

import { ATTEMPT_WINDOW_MS, DEFAULT_ATTEMPT_LIMIT } from './relayPolicy.mjs'

export { ATTEMPT_WINDOW_MS }

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
  // The cast widens the inferred literal type `'unknown'` to `string`:
  // without it, TypeScript reads this default as the ONLY shape
  // `peerAddress` can have and every caller's real function is a type
  // error. (JS inference, so it has to be asserted here rather than
  // annotated.)
  peerAddress = /** @type {() => string} */ (() => 'unknown'),
} = {}) {
  /**
   * Address lookup that never throws: a peer-address resolver that blows
   * up would otherwise kill the request path before the reply is sent and
   * the room would hang in "connecting". Degrading to 'unknown' falls
   * back to the shared budget, which is strictly MORE conservative than
   * skipping the IP check.
   */
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
   *
   * The caller passes a peer-shaped object (`{ data: { peerId } }`) so
   * both runtimes share this code verbatim; the worker mints a fresh
   * `peerId` per upgrade and keys the IP bucket on `CF-Connecting-IP`.
   */
  function allow(ws) {
    const t = now()
    const keys = [`sock:${ws?.data?.peerId}`, `ip:${safeAddress(ws)}`]
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
