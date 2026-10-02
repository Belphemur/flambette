/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

/**
 * The create/join throttle at the wire (the port of
 * src/lib/relayThrottle.test.ts onto the deployed relay).
 *
 * This file is its own vitest project on purpose: the attempt budget is
 * per-isolate module state, and this project pins RELAY_ATTEMPT_LIMIT to
 * 3 so the boundary costs three dials instead of thirty. The specs read
 * the limit back from the health body rather than assuming it, which is
 * exactly why the relay echoes its configuration there.
 *
 * ONE test, because the budget is shared by every test in this isolate:
 * the boundary and the liveness guarantee it protects have to be observed
 * inside a single spend.
 */

const ROOM = 'R90001'

class Peer {
  readonly frames: Record<string, unknown>[] = []
  #waiters: ((frame: Record<string, unknown>) => void)[] = []

  constructor(readonly ws: WebSocket) {
    ws.accept()
    ws.addEventListener('message', (e) => {
      const frame = JSON.parse(e.data as string)
      // Exactly-once delivery: a frame that satisfies a pending waiter is
      // handed to it and NOT buffered, or a later next() would hand the
      // same frame to the next assertion and let it pass on a stale ack.
      const waiter = this.#waiters.shift()
      if (waiter) waiter(frame)
      else this.frames.push(frame)
    })
  }

  send(payload: unknown): void {
    this.ws.send(JSON.stringify(payload))
  }

  next(timeoutMs = 2_000): Promise<Record<string, unknown>> {
    const pending = this.frames.shift()
    if (pending) return Promise.resolve(pending)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for a frame')), timeoutMs)
      this.#waiters.push((frame) => {
        clearTimeout(timer)
        resolve(frame)
      })
    })
  }

  async expect(type: string): Promise<Record<string, unknown>> {
    for (;;) {
      const frame = await this.next()
      if (frame.type === type) return frame
    }
  }

  /**
   * The next state frame carrying `rev`.
   *
   * Matching on the rev rather than stopping at the first state frame
   * keeps the assertion honest when the runtime redelivers a frame: the
   * duplicate is consumed and the revision the room was asked about
   * still has to show up.
   */
  async expectState(rev: number): Promise<Record<string, unknown>> {
    for (;;) {
      const frame = await this.next()
      if (frame.type === 'state' && frame.rev === rev) return frame
    }
  }

  close(): void {
    this.ws.close(1000, 'done')
  }
}

async function dial(path: string): Promise<Peer> {
  const response = await SELF.fetch(`https://relay.test${path}`, {
    headers: { Upgrade: 'websocket' },
  })
  expect(response.status).toBe(101)
  expect(response.webSocket).toBeTruthy()
  return new Peer(response.webSocket!)
}

async function attemptLimit(): Promise<number> {
  const response = await SELF.fetch('https://relay.test/')
  const body = await response.json<{ attemptLimit: number }>()
  return body.attemptLimit
}

describe('per-IP throttle', () => {
  it('blocks create/join at the limit and never starves a live household', async () => {
    const limit = await attemptLimit()
    expect(limit).toBe(3)

    // Spend the budget: 1 create + (limit - 1) joins. The LAST join stays
    // open — it is the witness that proves liveness outlives the budget.
    const a = await dial(`/?op=create&room=${ROOM}`)
    await a.expect('created')
    let witness: Peer | null = null
    for (let i = 1; i < limit; i++) {
      const p = await dial(`/?op=join&room=${ROOM}`)
      await p.expect('joined')
      witness = p // the final successful join is kept open
    }

    // The next attempt is refused, and the refusal is a relay MESSAGE on an
    // accepted WebSocket, not a rejected handshake.
    const refused = await dial(`/?op=join&room=${ROOM}`)
    expect(await refused.expect('error')).toMatchObject({ type: 'error', code: 'rate_limited' })

    // Liveness frames are not create/join attempts: the exhausted bucket
    // must not be able to starve a household that is already in the room.
    for (let i = 0; i < 5; i++) {
      a.send({ type: 'keepalive' })
      await a.expect('keepalive_ack')
    }

    // …and state fan-out still reaches the other peers.
    await a.send({ type: 'state', rev: 1, state: { plan: [] } })
    await witness!.expectState(1) // rev 1 landed
    await a.send({ type: 'state', rev: 2, state: { plan: [{ id: 1 }] } })
    await witness!.expectState(2)
    a.close()
    witness!.close()
  })
})