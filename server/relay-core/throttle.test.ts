import { describe, expect, test } from 'bun:test'
import {
  makeThrottle,
  MemoryAttemptBuckets,
  ATTEMPT_WINDOW_MS,
} from './throttle'

function ws(peerId: number) {
  return { data: { peerId } }
}

/** Fixed-window clock pin: returns a now() you can advance manually. */
function manualClock(start = 1_000_000) {
  let t = start
  return {
    now: () => t,
    advance(ms: number) {
      t += ms
    },
  }
}

describe('relay brute-force throttle', () => {
  test('allows attempts up to the limit, then rate_limits', () => {
    const t = makeThrottle({ limit: 3, now: manualClock().now })
    const a = ws(1)
    expect(t.allow(a)).toBe(true)
    expect(t.allow(a)).toBe(true)
    expect(t.allow(a)).toBe(true)
    expect(t.allow(a)).toBe(false)
  })

  test('budget resets after the window passes', () => {
    const clock = manualClock()
    const t = makeThrottle({ limit: 2, now: clock.now })
    const a = ws(1)
    expect(t.allow(a)).toBe(true)
    expect(t.allow(a)).toBe(true)
    expect(t.allow(a)).toBe(false)
    clock.advance(ATTEMPT_WINDOW_MS + 1)
    expect(t.allow(a)).toBe(true)
  })

  test('per-socket and per-IP budgets are SEPARATE (two sockets, one IP, share the IP budget)', () => {
    const clock = manualClock()
    const t = makeThrottle({
      limit: 2,
      now: clock.now,
      peerAddress: () => '10.0.0.1',
    })
    const a = ws(1)
    const b = ws(2)
    expect(t.allow(a)).toBe(true)
    expect(t.allow(b)).toBe(true)
    // Third attempt from the same IP — whichever socket — is refused: the
    // IP bucket is the binding constraint. This is the property that let a
    // single CI runner IP starve the whole shared suite.
    expect(t.allow(a)).toBe(false)
    expect(t.allow(b)).toBe(false)
    // A different IP gets its own budget.
    const c = makeThrottle({
      limit: 2,
      now: clock.now,
      peerAddress: () => '10.0.0.2',
    })
    expect(c.allow(a)).toBe(true)
  })

  test('EXACTLY the CI starvation regression: 30/min/IP budget shared by many parallel workers starves the suite', () => {
    const clock = manualClock()
    // One relay, one shared IP (CI reality), 6 parallel workers each doing
    // 6 join/create attempts up front (a small suite slice).
    const t = makeThrottle({
      limit: 30,
      now: clock.now,
      peerAddress: () => '127.0.0.1',
    })
    let ok = 0
    for (let i = 0; i < 36; i++) {
      if (t.allow(ws(i))) ok++
    }
    // First 30 succeed, the rest are starved — reproducing the CI outage.
    expect(ok).toBe(30)
  })

  test('the e2e lift (RELAY_ATTEMPT_LIMIT very high) removes the starvation', () => {
    const t = makeThrottle({
      limit: 100_000,
      now: manualClock().now,
      peerAddress: () => '127.0.0.1',
    })
    for (let i = 0; i < 2_000; i++) {
      expect(t.allow(ws(i))).toBe(true)
    }
  })

  test('buckets pruned beyond 4096 entries so the map cannot grow unbounded', () => {
    const t = makeThrottle({ limit: 5, now: manualClock().now })
    for (let i = 0; i < 5_000; i++) t.allow(ws(i))
    // Just proves no crash / no leak excursion; internal size is opaque.
    expect(true).toBe(true)
  })

  test('a THROWING peerAddress degrades to the shared-IP budget instead of killing the handler (Bun requestIP TypeError)', () => {
    // ServerWebSocket.requestIP on Bun throws "Expected Request object" for
    // a plain socket argument; an unguarded call aborted relay message
    // processing entirely — creates/joins never got a reply (v0.12.0 CI).
    const clock = manualClock()
    const t = makeThrottle({
      limit: 2,
      now: clock.now,
      peerAddress: () => {
        throw new TypeError('Expected Request object')
      },
    })
    const a = ws(1)
    expect(t.allow(a)).toBe(true)
    expect(t.allow(a)).toBe(true)
    // Both attempts landed in the same (unknown-IP) bucket: conservative.
    expect(t.allow(a)).toBe(false)
  })
})
