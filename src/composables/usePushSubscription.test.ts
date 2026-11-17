import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  fetchVapidPublicKey,
  relayBase,
  resetVapidKeyMemoForTests,
} from './usePushSubscription'

/**
 * The push composable's pure seams, pinned at the unit level
 * (ADR-0102 review hardening):
 *
 *  1. `relayBase` unwraps the WebSocket override to its HTTP twin —
 *     `fetch()` only speaks http(s), so a raw `wss:` origin would make
 *     the hosted app's key lookup fail forever.
 *  2. `fetchVapidPublicKey` memoizes only SUCCESS: a failed lookup is
 *     retried by the next sync instead of disabling push for the page;
 *     a definitive "no keys configured" answer IS the relay's
 *     configuration and stays cached.
 */

const originalLocation = globalThis.location
const originalFetch = globalThis.fetch
const originalOverride = import.meta.env.VITE_RELAY_WS_URL

beforeEach(() => {
  resetVapidKeyMemoForTests()
  ;(globalThis as { location?: unknown }).location = { origin: 'http://app.test' }
})

afterEach(() => {
  globalThis.location = originalLocation
  globalThis.fetch = originalFetch
  import.meta.env.VITE_RELAY_WS_URL = originalOverride
})

/** Install a fetch stub that records its calls and answers from a script. */
function stubFetch(handler: (url: string) => Response | never): { calls: string[] } {
  const calls: string[] = []
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input)
    calls.push(url)
    return handler(url)
  }) as typeof fetch
  return { calls }
}

describe('relayBase (the key-fetch origin)', () => {
  test('a wss: override is unwrapped to its https origin', () => {
    import.meta.env.VITE_RELAY_WS_URL = 'wss://ws.flambette.app/ws'
    expect(relayBase()).toBe('https://ws.flambette.app')
  })

  test('a ws: override is unwrapped to its http origin', () => {
    import.meta.env.VITE_RELAY_WS_URL = 'ws://lan-host:8081/ws'
    expect(relayBase()).toBe('http://lan-host:8081')
  })

  test('a nonsense override degrades to same-origin', () => {
    import.meta.env.VITE_RELAY_WS_URL = 'not a url'
    expect(relayBase()).toBe('http://app.test')
  })
})

describe('fetchVapidPublicKey (memoize only success)', () => {
  test('a successful key is memoized across calls', async () => {
    const { calls } = stubFetch(() => Response.json({ vapidPublicKey: 'PUB-KEY' }))
    expect(await fetchVapidPublicKey()).toBe('PUB-KEY')
    expect(await fetchVapidPublicKey()).toBe('PUB-KEY')
    expect(calls).toHaveLength(1)
  })

  test('a failed fetch is NOT memoized — the next sync retries', async () => {
    let fail = true
    const { calls } = stubFetch(() => {
      if (fail) throw new Error('network down')
      return Response.json({ vapidPublicKey: 'PUB-KEY' })
    })
    expect(await fetchVapidPublicKey()).toBeNull()
    fail = false
    expect(await fetchVapidPublicKey()).toBe('PUB-KEY')
    expect(calls).toHaveLength(2)
  })

  test('a non-OK answer is NOT memoized either', async () => {
    let fail = true
    const { calls } = stubFetch(() => {
      if (fail) return new Response(null, { status: 503 })
      return Response.json({ vapidPublicKey: 'PUB-KEY' })
    })
    expect(await fetchVapidPublicKey()).toBeNull()
    fail = false
    expect(await fetchVapidPublicKey()).toBe('PUB-KEY')
    expect(calls).toHaveLength(2)
  })

  test('a definitive "no keys configured" answer stays cached', async () => {
    const { calls } = stubFetch(() => Response.json({}))
    expect(await fetchVapidPublicKey()).toBeNull()
    expect(await fetchVapidPublicKey()).toBeNull()
    // The relay's configuration, not a transport failure: one lookup.
    expect(calls).toHaveLength(1)
  })
})
