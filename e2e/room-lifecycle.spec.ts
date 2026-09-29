import { expect, test } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'

/**
 * Room lifecycle (ADR-0026) at the WIRE level, against a dedicated relay
 * with a ~1.5s inactivity clock.
 *
 * The suite's own relay (playwright.config webServer) runs with production
 * TTLs, so the 1h expiry and its `room_expired` reply are unreachable
 * there. This spec spawns a second, short-TTL relay and speaks the
 * protocol directly from Node (global WebSocket) — the app always reaches
 * its relay through the /ws proxy on 8081, which cannot be repointed per
 * test.
 *
 * The port is derived from the worker index so parallel workers (and both
 * projects) never fight over one listener; a leftover relay from an
 * earlier run on the same port is compatible — it was started with the
 * same TTL — so the spec is self-healing rather than flaky.
 *
 * The app-level half of the same behaviour (a first joiner going live on
 * a code the relay has never seen, including the household auto-join
 * path) lives in room.spec.ts and waste-diet-household.spec.ts.
 */

const INACTIVITY_TTL_MS = 1_500
const KEEPALIVE_EVERY_MS = 300

let relay: ChildProcess | null = null
let relayUrl = ''

test.beforeAll(async () => {
  const port = 8099 + test.info().workerIndex
  relayUrl = `ws://localhost:${port}`
  try {
    const probe = await fetch(`http://localhost:${port}/`)
    if (probe.ok) return // compatible leftover from an earlier run
  } catch {
    /* not listening yet */
  }
  relay = spawn(
    'bun',
    ['server/relay.mjs'],
    {
      env: {
        ...process.env,
        PORT: String(port),
        RELAY_INACTIVITY_TTL_MS: String(INACTIVITY_TTL_MS),
        RELAY_ATTEMPT_LIMIT: '100000',
      },
      stdio: 'ignore',
    },
  )
  const deadline = Date.now() + 20_000
  for (;;) {
    try {
      const res = await fetch(`http://localhost:${port}/`)
      if (res.ok) return
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`short-TTL relay did not start on :${port}`)
    await new Promise((r) => setTimeout(r, 200))
  }
})

test.afterAll(() => {
  relay?.kill()
  relay = null
})

/** A raw relay peer: send frames, collect replies. */
class Peer {
  private ws!: WebSocket
  readonly received: Record<string, unknown>[] = []

  static async open() {
    const peer = new Peer()
    peer.ws = new WebSocket(relayUrl)
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

test('keepalive never spends the create/join budget', async () => {
  const a = await Peer.open()
  a.send({ type: 'join', code: 'amber-lantern-falcon' })
  await a.waitFor('created')
  // Budget of 3 per window: a long-lived room keepalives forever.
  for (let i = 0; i < 40; i++) {
    a.send({ type: 'keepalive' })
    await wait(10)
  }
  const last = a.received[a.received.length - 1]
  expect(last).toMatchObject({ type: 'keepalive_ack' })
  expect(a.received.some((m) => m.code === 'rate_limited')).toBe(false)
  a.close()
})
