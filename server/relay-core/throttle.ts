/**
 * Brute-force throttle: the window/limit arithmetic, with no runtime
 * assumptions at all.
 *
 * Used by BOTH relays (ADR-0040, promoting the former
 * `server/throttleCore.mjs`). The env-tunable default is NOT here — a
 * module-scope `process.env` read is fine under Bun and fatal in workerd,
 * so the fallback is the adapter's job: `server/relay.ts` reads
 * `RELAY_ATTEMPT_LIMIT` and passes the limit in, and the worker reads the
 * `RELAY_ATTEMPT_LIMIT` var from its env.
 *
 * Every dependency is injectable so the decision-table specs can pin the
 * clock, the limit and the peer address without opening sockets.
 */

import { ATTEMPT_WINDOW_MS, DEFAULT_ATTEMPT_LIMIT } from './policy'

export { ATTEMPT_WINDOW_MS }

/** Simple Map-backed bucket store (swap for a fake in tests). */
export class MemoryAttemptBuckets {
  #map = new Map<string, AttemptBucket>()

  get(key: string): AttemptBucket | undefined {
    return this.#map.get(key)
  }

  set(key: string, value: AttemptBucket): void {
    this.#map.set(key, value)
  }

  delete(key: string): void {
    this.#map.delete(key)
  }

  get size(): number {
    return this.#map.size
  }

  entries(): IterableIterator<[string, AttemptBucket]> {
    return this.#map.entries()
  }

  clear(): void {
    this.#map.clear()
  }
}

/** One fixed window's tally for one budget key. */
export interface AttemptBucket {
  start: number
  count: number
}

/** What the throttle needs to know about an attempt. */
export interface ThrottlePeer {
  data?: { peerId?: string | number | undefined } | undefined
}

/** Bucket keys beyond this are pruned opportunistically, so the map stays bounded. */
const PRUNE_ABOVE_BUCKETS = 4096

export interface ThrottleOptions {
  limit?: number
  windowMs?: number
  buckets?: AttemptBuckets
  now?: () => number
  peerAddress?: (peer: ThrottlePeer) => string
}

export interface Throttle {
  /** One create/join attempt against BOTH the per-socket and per-IP budgets. */
  allow: (peer: ThrottlePeer) => boolean
  limit: number
  windowMs: number
}

/** The subset of Map the throttle reads; lets tests hand it a frozen one. */
export interface AttemptBuckets {
  get: (key: string) => AttemptBucket | undefined
  set: (key: string, value: AttemptBucket) => void
  delete: (key: string) => void
  readonly size: number
  entries: () => IterableIterator<[string, AttemptBucket]>
  clear: () => void
}

export function makeThrottle({
  limit = DEFAULT_ATTEMPT_LIMIT,
  windowMs = ATTEMPT_WINDOW_MS,
  buckets = new MemoryAttemptBuckets(),
  now = () => Date.now(),
  peerAddress = () => 'unknown',
}: ThrottleOptions = {}): Throttle {
  /**
   * Address lookup that never throws: a peer-address resolver that blows
   * up would otherwise kill the request path before the reply is sent and
   * the room would hang in "connecting". Degrading to 'unknown' falls
   * back to the shared budget, which is strictly MORE conservative than
   * skipping the IP check.
   */
  function safeAddress(peer: ThrottlePeer): string {
    try {
      return peerAddress(peer) ?? 'unknown'
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
  function allow(peer: ThrottlePeer): boolean {
    const t = now()
    const keys = [`sock:${peer?.data?.peerId}`, `ip:${safeAddress(peer)}`]
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
    if (buckets.size > PRUNE_ABOVE_BUCKETS) {
      for (const [key, bucket] of buckets.entries()) {
        if (t - bucket.start > windowMs) buckets.delete(key)
      }
    }
    return true
  }

  return { allow, limit, windowMs }
}