import { expect, test } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'

/**
 * Room lifecycle (ADR-0026) at the WIRE level, against dedicated relays
 * with short clocks.
 *
 * The suite's own relay (playwright.config webServer) runs with production
 * TTLs, so the 24h expiry and its `room_expired` reply are unreachable
 * there. This spec spawns its own relays and speaks the protocol directly
 * from Node (global WebSocket) — the app always reaches its relay through
 * the /ws proxy on 8081, which cannot be repointed per test.
 *
 * Ports are derived from the worker index so parallel workers (and both
 * projects) never fight over one listener. A leftover relay is adopted
 * ONLY when it reports the same lifecycle configuration (the relay's HTTP
 * health body echoes it); otherwise the spec walks to the next port, so
 * a stale process can never silently invalidate a timing.
 *
 * The app-level half of the same behaviour (a first joiner going live on
 * a code the relay has never seen, including the household auto-join
 * path) lives in room.spec.ts and waste-diet-household.spec.ts.
 */

const INACTIVITY_TTL_MS = 1_500
const KEEPALIVE_EVERY_MS = 300
/** Mirrors the relay's default idle backstop (server/relay-core/policy.ts: 7 days). */
const IDLE_TTL_DEFAULT_MS = 7 * 24 * 60 * 60 * 1000

/** Child relays this worker started, killed in afterAll. */
const spawned: ChildProcess[] = []
/** Base port; each relay slot adds its own offset so they never collide. */
let portBase = 8099

/**
 * Start (or adopt) a dedicated relay with a specific environment and
 * return its ws:// URL. Slot 0 is the default short-TTL relay; extra
 * slots let a case pick its OWN TTLs / attempt limit (review F1 and F7
 * both need a configuration the default relay does not have).
 */
async function startRelay(slot: number, env: Record<string, string>): Promise<string> {
  const want = {
    inactivityTtlMs: Number(env.RELAY_INACTIVITY_TTL_MS ?? INACTIVITY_TTL_MS),
    idleTtlMs: Number(env.RELAY_IDLE_TTL_MS ?? IDLE_TTL_DEFAULT_MS),
    attemptLimit: Number(env.RELAY_ATTEMPT_LIMIT ?? 30),
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const port = portBase + slot + attempt * 50
    const url = `ws://localhost:${port}`
    const probe = async () => {
      const res = await fetch(`http://localhost:${port}/`).catch(() => null)
      if (!res || !res.ok) return { reachable: false, config: null as Record<string, number> | null }
      // A relay that does not report its config (e.g. a much older build)
      // is never adopted: it would invalidate every timing in the case.
      const body = await res.json().catch(() => null)
      return { reachable: true, config: body as Record<string, number> | null }
    }
    const live = await probe()
    if (live.reachable) {
      if (
        live.config?.inactivityTtlMs === want.inactivityTtlMs &&
        live.config?.idleTtlMs === want.idleTtlMs &&
        live.config?.attemptLimit === want.attemptLimit
      ) {
        return url
      }
      continue // occupied by a DIFFERENT configuration — take the next port
    }
    const child = spawn('bun', ['server/relay.ts'], {
      env: { ...process.env, PORT: String(port), ...env },
      stdio: 'ignore',
    })
    spawned.push(child)
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      if ((await probe()).reachable) return url
      await new Promise((r) => setTimeout(r, 100))
    }
    child.kill()
    throw new Error(`relay did not start on :${port}`)
  }
  throw new Error(`no free port for a relay with ${JSON.stringify(want)} near :${portBase + slot}`)
}

/** The default relay: 1.5s inactivity, no artificial throttle ceiling. */
let relayUrl = ''

test.beforeAll(async () => {
  portBase = 8099 + test.info().workerIndex * 10
  relayUrl = await startRelay(0, {
    RELAY_INACTIVITY_TTL_MS: String(INACTIVITY_TTL_MS),
    RELAY_ATTEMPT_LIMIT: '100000',
  })
})

test.afterAll(() => {
  for (const child of spawned) child.kill()
  spawned.length = 0
})

/** A raw relay peer: send frames, collect replies. */
class Peer {
  private ws!: WebSocket
  readonly received: Record<string, unknown>[] = []

  static async open(url = relayUrl) {
    const peer = new Peer()
    peer.ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      peer.ws.addEventListener('open', resolve, { once: true })
      peer.ws.addEventListener('error', reject, { once: true })
    })
    peer.ws.addEventListener('message', (event) => {
      peer.received.push(JSON.parse(String(event.data)) as Record<string, unknown>)
    })
    return peer
  }

  send(payload: Record<string, unknown>) {
    this.ws.send(JSON.stringify(payload))
  }

  /** Forget the frames seen so far, so waitFor() only matches new ones. */
  reset() {
    this.received.length = 0
  }

  /** Resolve with the first frame of `type` seen from now on. */
  waitFor(type: string, timeout = 5_000): Promise<Record<string, unknown>> {
    const already = this.received.find((m) => m.type === type)
    if (already) return Promise.resolve(already)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ws.removeEventListener('message', onMessage)
        reject(new Error(`no ${type} frame; got ${JSON.stringify(this.received)}`))
      }, timeout)
      const onMessage = (event: MessageEvent) => {
        const msg = JSON.parse(String(event.data)) as Record<string, unknown>
        if (msg.type !== type) return
        clearTimeout(timer)
        this.ws.removeEventListener('message', onMessage)
        resolve(msg)
      }
      this.ws.addEventListener('message', onMessage)
    })
  }

  countOf(type: string): number {
    return this.received.filter((m) => m.type === type).length
  }

  close() {
    this.ws.close()
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('a first join ESTABLISHES the room (no not_found) and later joins get the state', async () => {
  const a = await Peer.open()
  a.send({ type: 'join', code: 'Mauve-Peacock-Candle' })
  // The owner's failing trace used to be exactly this error.
  expect(await a.waitFor('created')).toMatchObject({ type: 'created', code: 'mauve-peacock-candle' })
  a.send({ type: 'state', rev: 7, state: { plan: [{ variantId: 1, servings: 6 }] } })

  const b = await Peer.open()
  b.send({ type: 'join', code: 'mauve-peacock-candle' })
  expect(await b.waitFor('joined')).toMatchObject({
    code: 'mauve-peacock-candle',
    rev: 7,
    state: { plan: [{ variantId: 1, servings: 6 }] },
  })
  expect(b.received.some((m) => m.type === 'error')).toBe(false)

  a.close()
  b.close()
})

test('keepalive refreshes the inactivity clock; a silent room is closed with room_expired', async () => {
  const a = await Peer.open()
  a.send({ type: 'join', code: 'jade-otter-lantern' })
  await a.waitFor('created')

  // Keepalive well before the window: the room survives several windows.
  for (let i = 0; i < 4; i++) {
    await wait(KEEPALIVE_EVERY_MS)
    a.reset()
    a.send({ type: 'keepalive' })
    expect(await a.waitFor('keepalive_ack')).toMatchObject({ type: 'keepalive_ack' })
  }

  // …then go silent: the room is closed and the peer is told to disconnect.
  const expired = await a.waitFor('error', INACTIVITY_TTL_MS * 3)
  expect(expired).toMatchObject({ type: 'error', code: 'room_expired', reason: 'inactive' })
  // The room is gone: a keepalive no longer refreshes anything.
  a.reset()
  a.send({ type: 'keepalive' })
  expect(await a.waitFor('error')).toMatchObject({ code: 'not_in_room' })

  a.close()
})

test('the last peer leaving deletes the room, and a later join re-creates it', async () => {
  const a = await Peer.open()
  const b = await Peer.open()
  a.send({ type: 'join', code: 'rose-thistle-moss' })
  await a.waitFor('created')
  b.send({ type: 'join', code: 'rose-thistle-moss' })
  await b.waitFor('joined')

  a.close()
  await wait(200)
  b.send({ type: 'leave' })
  await b.waitFor('left')
  await wait(200)

  // Empty ⇒ deleted (no state, no room): the next join is a fresh create.
  const c = await Peer.open()
  c.send({ type: 'join', code: 'rose-thistle-moss' })
  expect(await c.waitFor('created')).toMatchObject({ code: 'rose-thistle-moss' })
  c.close()
})

test('keepalive never spends the create/join budget (F7)', async () => {
  // A SMALL attempt limit, so this can actually fail: with the suite's
  // usual 100000 ceiling a throttled keepalive could never be observed
  // (that was review finding F7 — the old version of this test was
  // unfalsifiable).
  const url = await startRelay(1, {
    RELAY_INACTIVITY_TTL_MS: '1500',
    RELAY_ATTEMPT_LIMIT: '3',
  })
  const a = await Peer.open(url)
  a.send({ type: 'join', code: 'amber-lantern-falcon' })
  await a.waitFor('created')

  // Positive control: the budget really is 3 per window here — a 4th
  // create/join from the same IP is refused…
  for (const code of ['willow-moss-lantern', 'pebble-falcon-otter']) {
    const other = await Peer.open(url)
    other.send({ type: 'join', code })
    await other.waitFor('created')
    other.close()
  }
  const probe = await Peer.open(url)
  probe.send({ type: 'join', code: 'ember-quartz-moss' })
  expect(await probe.waitFor('error')).toMatchObject({ code: 'rate_limited' })
  probe.close()

  // …while keepalives keep flowing for well over a full inactivity
  // window. Each iteration asserts a FRESH ack (the received log is
  // reset first), so a dead keepalive cannot pass on iteration 1's ack.
  for (let i = 0; i < 8; i++) {
    await wait(KEEPALIVE_EVERY_MS)
    a.reset()
    a.send({ type: 'keepalive' })
    expect(await a.waitFor('keepalive_ack')).toMatchObject({ type: 'keepalive_ack' })
  }
  // 2.4s of keepalives with a 1.5s window: the room was never closed.
  expect(a.countOf('error')).toBe(0)
  a.send({ type: 'state', rev: 1, state: { plan: [] } })
  a.close()
})

test('keepalive keeps a connected room alive past the idle backstop (F1)', async () => {
  // The idle backstop is SHORTER than the inactivity window, so the room
  // can only survive if keepalive refreshes BOTH clocks. Before F1 the
  // keepalive refreshed only the inactivity clock and this peer was closed with
  // room_expired/idle after 2s of perfectly healthy keepalives.
  const url = await startRelay(2, {
    RELAY_INACTIVITY_TTL_MS: '60000',
    RELAY_IDLE_TTL_MS: '2000',
    RELAY_ATTEMPT_LIMIT: '100000',
  })
  const a = await Peer.open(url)
  a.send({ type: 'join', code: 'amber-falcon-lantern' })
  await a.waitFor('created')

  // 3.6s of keepalives against a 2s idle backstop, no state traffic.
  for (let i = 0; i < 12; i++) {
    await wait(300)
    a.send({ type: 'keepalive' })
  }
  await wait(300)
  expect(a.countOf('keepalive_ack')).toBe(12)
  expect(a.countOf('error')).toBe(0)

  // Control: once the keepalives stop, the room does close.
  a.reset()
  expect(await a.waitFor('error', 5000)).toMatchObject({ code: 'room_expired' })
  a.close()
})

test('an expired peer cannot write into a room re-created under the same code (F2)', async () => {
  const url = await startRelay(3, {
    RELAY_INACTIVITY_TTL_MS: '2500',
    RELAY_IDLE_TTL_MS: '60000',
    RELAY_ATTEMPT_LIMIT: '100000',
  })
  const stale = await Peer.open(url)
  stale.send({ type: 'join', code: 'jade-willow-otter' })
  await stale.waitFor('created')
  stale.send({ type: 'state', rev: 3, state: { plan: ['stale'] } })

  // Silence: the room expires and `stale` is told to disconnect.
  stale.reset()
  expect(await stale.waitFor('error', 5000)).toMatchObject({ code: 'room_expired' })

  // Another peer re-creates the same code with a fresh plan.
  const fresh = await Peer.open(url)
  fresh.send({ type: 'join', code: 'jade-willow-otter' })
  expect(await fresh.waitFor('created')).toMatchObject({ code: 'jade-willow-otter' })
  fresh.send({ type: 'state', rev: 99, state: { plan: ['fresh'] } })

  // The expired socket's roomCode was cleared, so its writes are refused…
  stale.reset()
  stale.send({ type: 'state', rev: 4, state: { plan: ['zombie'] } })
  expect(await stale.waitFor('error')).toMatchObject({ code: 'bad_state' })

  // …and its `leave` cannot delete the room it no longer belongs to.
  stale.reset()
  stale.send({ type: 'leave' })
  expect(await stale.waitFor('left')).toBeDefined()
  const reader = await Peer.open(url)
  reader.send({ type: 'join', code: 'jade-willow-otter' })
  expect(await reader.waitFor('joined')).toMatchObject({ rev: 99, state: { plan: ['fresh'] } })

  reader.close()
  stale.close()
  fresh.close()
})

test('leaving a room for another does not leave a zombie peer behind (F3)', async () => {
  const url = await startRelay(4, {
    RELAY_INACTIVITY_TTL_MS: '1200',
    RELAY_IDLE_TTL_MS: '60000',
    RELAY_ATTEMPT_LIMIT: '100000',
  })
  const solo = await Peer.open(url)
  solo.send({ type: 'join', code: 'ember-willow-quartz' })
  await solo.waitFor('created')
  // Another peer keeps the first room alive so it cannot simply expire.
  const keeper = await Peer.open(url)
  keeper.send({ type: 'join', code: 'ember-willow-quartz' })
  await keeper.waitFor('joined')

  // `solo` moves to a different room…
  solo.reset()
  solo.send({ type: 'join', code: 'rose-thistle-moss' })
  expect(await solo.waitFor('created')).toMatchObject({ code: 'rose-thistle-moss' })

  // …so the first room's expiry must NOT send it a terminal error, even
  // though that room really does close while it is away. `solo` keeps
  // its NEW room alive with keepalives, so anything it hears is a leak.
  // No frame log resets here on purpose: a terminal error that lands
  // between two ticks must still be seen by the assertion below.
  for (let i = 0; i < 8; i++) {
    await wait(300)
    solo.send({ type: 'keepalive' })
  }
  await wait(300)
  expect(solo.countOf('keepalive_ack')).toBe(8)
  expect(solo.countOf('error')).toBe(0)
  // The room it left DID expire (its remaining peer was told) — the point
  // is that a client which moved on is not one of its victims.
  expect(await keeper.waitFor('error', 5000)).toMatchObject({ code: 'room_expired' })

  keeper.close()
  solo.close()
})

test('a re-created room continues the household revision history (F4)', async () => {
  const a = await Peer.open()
  a.send({ type: 'join', code: 'pebble-moss-falcon' })
  await a.waitFor('created')
  a.send({ type: 'state', rev: 12, state: { plan: ['household'] } })

  // Everyone leaves: the room (and its state) is deleted…
  a.send({ type: 'leave' })
  await a.waitFor('left')
  await wait(200)
  a.close()

  // …and the next joiner is told the floor, so the room continues at 12
  // instead of restarting at 0 and being mistaken for "newer than what
  // the household already had".
  const b = await Peer.open()
  b.send({ type: 'join', code: 'pebble-moss-falcon' })
  expect(await b.waitFor('created')).toMatchObject({ code: 'pebble-moss-falcon', rev: 12 })
  b.close()
})
