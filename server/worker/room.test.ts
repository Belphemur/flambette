/// <reference types="@cloudflare/vitest-plugin/types" />
import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
  SELF,
} from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

/**
 * Room lifecycle (ADR-0026, as deployed per ADR-0038) at the WIRE level,
 * against the real Room Durable Object in workerd.
 *
 * These are the room scenarios exercised at the WIRE level against the
 * real Room Durable Object in workerd. The authoritative rules live in
 * ../relay-core/lifecycle.test.ts, which pins every one of them against the
 * shared core (ADR-0040); what only this file can see is the deployment
 * around it — hibernation, SELF.fetch routing, and storage surviving
 * eviction. Every case below goes through the worker entry's upgrade path
 * (intent in the URL, `idFromName` routing) and speaks the same JSON the
 * client does.
 *
 *
 * Every test dials its OWN room code: the pool rolls each test's storage
 * back, but the object instances and their sockets are shared inside one
 * isolate, so two tests that share a code would see each other's peers
 * and each other's `code_taken` verdicts. Isolated rooms make the specs
 * as independent as the storage they run on.
 */

/** A connected client: collects relay frames until a test asks for one. */
class Peer {
  readonly frames: Record<string, unknown>[] = []
  #waiters: ((frame: Record<string, unknown>) => void)[] = []
  readonly closed: Promise<number>

  constructor(readonly ws: WebSocket) {
    ws.accept()
    this.closed = new Promise((resolve) => {
      ws.addEventListener('close', (e) => resolve(e.code))
    })
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

  /** Next frame of ANY type, consuming the buffer first. */
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

  /** The next frame of the given type, skipping anything else. */
  async expect(type: string): Promise<Record<string, unknown>> {
    for (;;) {
      const frame = await this.next()
      if (frame.type === type) return frame
    }
  }

  /**
   * The next `error` frame carrying `code`.
   *
   * Matching on the code rather than stopping at the first error frame
   * keeps the assertion honest when the runtime redelivers a frame: the
   * duplicate is consumed and the code the room was asked about still has
   * to show up.
   */
  async expectError(code: string): Promise<Record<string, unknown>> {
    for (;;) {
      const frame = await this.next()
      if (frame.type === 'error' && frame.code === code) return frame
    }
  }

  close(): void {
    this.ws.close(1000, 'done')
  }
}

/**
 * Monotonic room code, unique per call.
 *
 * Legacy shape (ADR-0021), and ALREADY canonical: the relay upper-cases a
 * legacy code, so a lowercase code here would name a different Durable
 * Object than the one the sockets are talking to.
 */
let roomCounter = 0
function nextRoom(): string {
  roomCounter += 1
  return `R${String(roomCounter).padStart(5, '0')}`
}

/**
 * Push from `sender` and wait until `listener` (a DIFFERENT peer) receives
 * the fan-out.
 *
 * The sender gets no acknowledgement for a state push — the fan-out to the
 * other peers is the only wire-visible proof the room stored it — so any
 * test that asserts on stored state AFTER a push must go through this
 * instead of racing the room's input queue.
 */
async function pushAndWait(
  sender: Peer,
  listener: Peer,
  payload: Record<string, unknown>,
): Promise<void> {
  sender.send(payload)
  await listener.expect('state')
}

/** Open a socket with the URL-carried intent (the client's only protocol). */
async function dial(path: string): Promise<Peer> {
  const response = await SELF.fetch(`https://relay.test${path}`, {
    headers: { Upgrade: 'websocket' },
  })
  expect(response.status).toBe(101)
  expect(response.webSocket).toBeTruthy()
  return new Peer(response.webSocket!)
}

/** The DO stub for a code — also how the tests reach its storage. */
function roomStub(code: string) {
  return env.ROOM.get(env.ROOM.idFromName(code))
}

/** Force the expiry deadline into the past, as if the clocks had run out. */
async function ageRoom(stub: DurableObjectStub, hours: number): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    const past = Date.now() - hours * 60 * 60 * 1000
    state.storage.sql.exec(
      'UPDATE room SET inactivity_at = ?, idle_at = ? WHERE id = 1',
      past,
      past,
    )
  })
}

/**
 * Await the STORAGE proof that a pushed rev landed in the room's DO. State
 * pushes have no acknowledgement, and `ageRoom` + the alarm race the async
 * store: if the store lands after the aging, the store refreshes the room's
 * timestamps, the alarm sees a fresh room and fires as a no-op — the expiry
 * frame is then never sent and the waiting spec times out (reproduced ~25%
 * of suite runs; the flaky CI `worker` job). The SQL row is the wire-less
 * proof the store ran.
 */
async function expectStoredRev(stub: DurableObjectStub, rev: number): Promise<void> {
  for (;;) {
    const rows = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec('SELECT rev FROM room WHERE id = 1').toArray(),
    )
    if (rows.some((row) => (row as { rev?: unknown }).rev === rev)) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('health', () => {
  it('answers a plain GET with the lifecycle configuration', async () => {
    const response = await SELF.fetch('https://relay.test/')
    expect(response.status).toBe(200)
    const body = await response.json<Record<string, unknown>>()
    expect(body.service).toBe('mealime-relay')
    expect(body.inactivityTtlMs).toBe(24 * 60 * 60 * 1000)
    expect(body.idleTtlMs).toBe(7 * 24 * 60 * 60 * 1000)
    expect(body.attemptLimit).toBeTypeOf('number')
  })
})

describe('join-or-create', () => {
  it('answers created to the first peer and carries the rev floor', async () => {
    const room = nextRoom()
    const a = await dial(`/?op=create&room=${room}`)
    const created = await a.expect('created')
    expect(created).toMatchObject({ type: 'created', code: room, rev: 0 })
    a.close()
  })

  it('answers joined (with state) to a later peer', async () => {
    const room = nextRoom()
    const a = await dial(`/?op=create&room=${room}`)
    await a.expect('created')
    const witness = await dial(`/?op=join&room=${room}`)
    await witness.expect('joined')
    // The fan-out to `witness` is what proves the room stored rev 3.
    await pushAndWait(a, witness, { type: 'state', rev: 3, state: { plan: [{ id: 1 }] } })

    const b = await dial(`/?op=join&room=${room}`)
    const joined = await b.expect('joined')
    expect(joined).toMatchObject({
      type: 'joined',
      code: room,
      rev: 3,
      state: { plan: [{ id: 1 }] },
    })
    a.close()
    witness.close()
    b.close()
  })

  it('a bare ?room=X is a join (join-or-create is the default intent)', async () => {
    const room = nextRoom()
    const a = await dial(`/?op=create&room=${room}`)
    await a.expect('created')
    const b = await dial(`/?room=${room}`)
    // The relay's join reply carries `state: null` until a peer has pushed
    // one — the same shape the Bun relay sends (`room.state ?? null`).
    expect((await b.expect('joined')).state).toBeNull()
    a.close()
    b.close()
  })

  it('refuses a create into a live room with code_taken', async () => {
    const room = nextRoom()
    const a = await dial(`/?op=create&room=${room}`)
    await a.expect('created')
    const b = await dial(`/?op=create&room=${room}`)
    expect(await b.expect('error')).toMatchObject({ type: 'error', code: 'code_taken' })
    expect(await b.closed).toBe(1000)
    a.close()
  })

  it('answers not_found for a join with an unusable code shape', async () => {
    const b = await dial('/?op=join&room=mauve-peacock') // 2 words: partial, refused
    expect(await b.expect('error')).toMatchObject({ type: 'error', code: 'not_found' })
  })

  it('a join onto a code the relay has never seen ESTABLISHES the room (ADR-0026)', async () => {
    // The first peer under a fresh code seeds it — the household member
    // who opens a shared link before its creator, or re-joins after an
    // expiry, must not hit a dead end.
    const room = nextRoom()
    const a = await dial(`/?op=join&room=${room}`)
    expect(await a.expect('created')).toMatchObject({ type: 'created', code: room, rev: 0 })
    a.send({ type: 'state', rev: 2, state: { plan: [{ id: 3 }] } })
    const b = await dial(`/?op=join&room=${room}`)
    expect(await b.expect('joined')).toMatchObject({ rev: 2, state: { plan: [{ id: 3 }] } })
    a.close()
    b.close()
  })

  it('mints a legacy code for a create that arrived without one', async () => {
    const a = await dial('/?op=create')
    const created = await a.expect('created')
    expect(created.code).toMatch(/^[0-9BCDFGHJKLMNPQRSTVWXZ]{6}$/)
    a.close()
  })
})

describe('peer count (ADR-0049)', () => {

  

  it('stitches the headcount into created and joined', async () => {
    const room = nextRoom()
    const a = await dial(`/?op=create&room=${room}`)
    // The first peer counts ITSELF: `count` is livePeers + 1, computed by
    // the core so both runtimes agree (ADR-0040).
    expect(await a.expect('created')).toMatchObject({ count: 1 })
    const b = await dial(`/?op=join&room=${room}`)
    expect(await b.expect('joined')).toMatchObject({ count: 2 })
    a.close()
    b.close()
  })

  it('broadcasts the new count to EVERY peer on a join, and again on a departure', async () => {
    const room = nextRoom()
    const a = await dial(`/?op=create&room=${room}`)
    await a.expect('created')
    // Drain a's own `peers` fan-out for its own admission (count 1).
    expect(await a.expect('peers')).toMatchObject({ type: 'peers', count: 1 })

    const b = await dial(`/?op=join&room=${room}`)
    await b.expect('joined')
    // The peer ALREADY in the room is told; a fan-out that only reached the
    // joiner would make the first household member's chip permanently lie.
    expect(await a.expect('peers')).toMatchObject({ type: 'peers', count: 2 })

    // A departure. Asserted on `a`'s frame, NOT on `b.closed`: the
    // client-side `close` event takes ~10 s to surface in the pool (the
    // runtime hands it over long after the DO's close handler has already
    // run), while the `peers` fan-out the handler sends arrives in
    // milliseconds. The assertion is about the fan-out anyway.
    b.close()
    expect(await a.expect('peers')).toMatchObject({ type: 'peers', count: 1 })
    a.close()
  })

  it('does not count a REFUSED socket', async () => {
    // `#refuse` uses `accept()`, not `ctx.acceptWebSocket`, so a refused
    // socket is never hibernated and can never inflate the headcount.
    const room = nextRoom()
    const a = await dial(`/?op=create&room=${room}`)
    await a.expect('created')
    await a.expect('peers')
    const b = await dial(`/?op=create&room=${room}`) // code_taken
    expect(await b.expectError('code_taken')).toMatchObject({ code: 'code_taken' })
    await b.closed
    // The refusal is NOT a membership change: the next admission's count is
    // 2, not 3. Asserted through `c` so the wait is on a frame that the
    // refusal provably did not produce.
    const c = await dial(`/?op=join&room=${room}`)
    expect(await c.expect('joined')).toMatchObject({ count: 2 })
    expect(await a.expect('peers')).toMatchObject({ type: 'peers', count: 2 })
    a.close()
    c.close()
  })
})

describe('state', () => {
  it('fans out to every peer EXCEPT the sender, with the sender id', async () => {
    const room = nextRoom()
    const a = await dial(`/?op=create&room=${room}`)
    await a.expect('created')
    const b = await dial(`/?op=join&room=${room}`)
    await b.expect('joined')
    b.frames.length = 0

    a.send({ type: 'state', rev: 5, state: { plan: [], favorites: ['x'] } })
    const seen = await b.expect('state')
    expect(seen).toMatchObject({ type: 'state', rev: 5, state: { favorites: ['x'] } })
    expect(typeof seen.from).toBe('string')
    // Peer ids are per-peer, so a third socket's broadcast cannot be
    // mistaken for this one's.
    const c = await dial(`/?op=join&room=${room}`)
    await c.expect('joined')
    b.frames.length = 0
    c.send({ type: 'state', rev: 6, state: { plan: [] } })
    expect(await b.expect('state')).toMatchObject({ rev: 6, from: 'p3' })
    a.close()
    b.close()
    c.close()
  })

  it('answers bad_state when the snapshot is not an object or rev is not finite', async () => {
    const room = nextRoom()
    const a = await dial(`/?op=create&room=${room}`)
    await a.expect('created')
    a.send({ type: 'state', rev: 'five', state: {} })
    expect(await a.expect('error')).toMatchObject({ code: 'bad_state' })
    a.send({ type: 'state', rev: 1, state: null })
    expect(await a.expect('error')).toMatchObject({ code: 'bad_state' })
    a.close()
  })

  it('preserves cookedHistory and planIdentity when the sender omits them', async () => {
    const room = nextRoom()
    const a = await dial(`/?op=create&room=${room}`)
    await a.expect('created')
    await a.send({
      type: 'state',
      rev: 1,
      state: { plan: [], cookedHistory: { 42: {} }, planIdentity: { id: 'p1' } },
    })
    const b = await dial(`/?op=join&room=${room}`)
    await b.expect('joined')
    // b omits BOTH keys: ADR-0032's opted-out sender is silent about
    // history, and an older peer has nothing to say about the plan (the
    // fan-out back to `a` is what proves this snapshot was stored).
    await pushAndWait(b, a, { type: 'state', rev: 2, state: { plan: [{ id: 2 }] } })

    const c = await dial(`/?op=join&room=${room}`)
    const joined = await c.expect('joined')
    // Absent on the wire, present in the room: carried forward, not wiped.
    expect(joined.state).toEqual({
      plan: [{ id: 2 }],
      cookedHistory: { 42: {} },
      planIdentity: { id: 'p1' },
    })
    a.close()
    b.close()
    c.close()
  })

  it('an EXPLICIT empty cookedHistory replaces it wholesale', async () => {
    // ADR-0032: a sharing sender always sends the key (even empty), so it
    // can never resurrect rows it itself dropped. Absence is the silent
    // case; `{}` is a real answer.
    const room = nextRoom()
    const a = await dial(`/?op=create&room=${room}`)
    await a.expect('created')
    await a.send({ type: 'state', rev: 1, state: { plan: [], cookedHistory: { 42: {} } } })
    const b = await dial(`/?op=join&room=${room}`)
    await b.expect('joined')
    await pushAndWait(b, a, { type: 'state', rev: 2, state: { plan: [], cookedHistory: {} } })

    const c = await dial(`/?op=join&room=${room}`)
    expect((await c.expect('joined')).state).toEqual({ plan: [], cookedHistory: {} })
    a.close()
    b.close()
    c.close()
  })

  it('a snapshot that EXPLICITLY sends planIdentity: null replaces it', async () => {
    const room = nextRoom()
    const a = await dial(`/?op=create&room=${room}`)
    await a.expect('created')
    await a.send({ type: 'state', rev: 1, state: { plan: [], planIdentity: { id: 'p1' } } })
    const b = await dial(`/?op=join&room=${room}`)
    await b.expect('joined')
    // A peer that really did end its plan must not be undone by the rule:
    // `null` is a real answer, unlike an absent key.
    await pushAndWait(b, a, { type: 'state', rev: 2, state: { plan: [], planIdentity: null } })

    const c = await dial(`/?op=join&room=${room}`)
    expect((await c.expect('joined')).state).toEqual({ plan: [], planIdentity: null })
    a.close()
    b.close()
    c.close()
  })
})

describe('liveness and expiry', () => {
  it('keepalive refreshes the expiry clock and is answered, never throttled', async () => {
    const room = nextRoom()
    const stub = roomStub(room)
    const a = await dial(`/?op=create&room=${room}`)
    await a.expect('created')

    const before = await runInDurableObject(stub, (_i, state) => state.storage.getAlarm())
    for (let i = 0; i < 5; i++) {
      a.send({ type: 'keepalive' })
      await a.expect('keepalive_ack')
    }
    const after = await runInDurableObject(stub, (_i, state) => state.storage.getAlarm())

    expect(before).toBeTypeOf('number')
    // The alarm is a full inactivity window away from the LAST keepalive:
    // each ack re-armed it, so it never drifted backwards.
    expect(after! - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000)
    a.close()
  })

  it('keepalive with no room answers not_in_room', async () => {
    const room = nextRoom()
    const a = await dial(`/?op=create&room=${room}`)
    await a.expect('created')
    // Detach this socket from its room, the way the relay does when a
    // socket has moved on (review F3): membership, not just the code.
    await runInDurableObject(roomStub(room), (_instance, state) => {
      for (const ws of state.getWebSockets()) {
        ws.serializeAttachment({ id: 'p999', code: 'someone-else-entirely' })
      }
    })
    a.send({ type: 'keepalive' })
    await a.expectError('not_in_room')
    // Membership, not just the code (review F2): the Bun relay folds the
    // membership check into the state guard, so both relays answer
    // bad_state here.
    a.send({ type: 'state', rev: 1, state: {} })
    await a.expectError('bad_state')
    a.close()
  })

  it('the alarm expires the room, tells every peer, and keeps the rev floor', async () => {
    const room = nextRoom()
    const a = await dial(`/?op=create&room=${room}`)
    await a.expect('created')
    const b = await dial(`/?op=join&room=${room}`)
    await b.expect('joined')
    await a.send({ type: 'state', rev: 9, state: { plan: [] } })
    await expectStoredRev(roomStub(room), 9)

    await ageRoom(roomStub(room), 25)
    await runDurableObjectAlarm(roomStub(room))

    expect(await a.expect('error')).toMatchObject({ code: 'room_expired', reason: 'inactive' })
    expect(await b.expect('error')).toMatchObject({ code: 'room_expired', reason: 'inactive' })
    expect(await a.closed).toBe(1000)

    // The room row is gone; the floor row is not (review F4).
    const row = await runInDurableObject(roomStub(room), (_i, state) => {
      const rooms = state.storage.sql.exec('SELECT rev, code FROM room WHERE id = 1').toArray()
      const floor = state.storage.sql
        .exec('SELECT rev, at FROM rev_floor WHERE code = ?', room)
        .toArray()
      return { rooms: rooms.length, floor }
    })
    expect(row.rooms).toBe(0)
    expect(row.floor).toHaveLength(1)
    expect(row.floor[0].rev).toBe(9)
  })

  it('an alarm that fires early (room still live within the window) is a no-op', async () => {
    const room = nextRoom()
    const a = await dial(`/?op=create&room=${room}`)
    await a.expect('created')
    await runDurableObjectAlarm(roomStub(room)) // deadline is still in the future
    expect(a.frames.some((f) => f.type === 'error')).toBe(false)
    a.send({ type: 'keepalive' })
    await a.expect('keepalive_ack')
    a.close()
  })

  it('a re-created room continues from the floor instead of restarting at 0', async () => {
    const room = nextRoom()
    const a = await dial(`/?op=create&room=${room}`)
    await a.expect('created')
    await a.send({ type: 'state', rev: 9, state: { plan: [] } })
    await expectStoredRev(roomStub(room), 9)
    await ageRoom(roomStub(room), 25)
    await runDurableObjectAlarm(roomStub(room))
    await a.expect('error')

    const again = await dial(`/?op=create&room=${room}`)
    expect(await again.expect('created')).toMatchObject({ type: 'created', code: room, rev: 9 })
    // The room was emptied by the expiry, not by a peer.
    const b = await dial(`/?op=join&room=${room}`)
    const joined = await b.expect('joined')
    expect(joined.rev).toBe(9)
    expect(joined.state).toBeNull()
    again.close()
    b.close()
  })

  it('the last peer leaving KEEPS the stored state (ADR-0038 §4)', async () => {
    const room = nextRoom()
    const a = await dial(`/?op=create&room=${room}`)
    await a.expect('created')
    await a.send({ type: 'state', rev: 4, state: { plan: [{ id: 7 }] } })
    a.send({ type: 'leave' })
    expect(await a.expect('left')).toMatchObject({ type: 'left' })
    expect(await a.closed).toBe(1000)

    const b = await dial(`/?op=join&room=${room}`)
    expect(await b.expect('joined')).toMatchObject({
      type: 'joined',
      rev: 4,
      state: { plan: [{ id: 7 }] },
    })
    b.close()
  })
})

describe('per-store schema (ADR-0088 §2/§4)', () => {
  it('the shared migration list runs lazily on the first event and records itself', async () => {
    const room = nextRoom()
    const a = await dial(`/?op=create&room=${room}`)
    await a.expect('created')
    a.close()

    const tables = await runInDurableObject(roomStub(room), (_i, state) => {
      const rows = state.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE type = 'table'")
        .toArray()
      return rows.map((row) => String((row as { name: unknown }).name))
    })
    expect(tables).toContain('room')
    expect(tables).toContain('schema_migrations')
    for (const store of ['plan', 'custom_items', 'checked', 'cleared', 'customs', 'cooked_history', 'filters', 'favorites', 'ratings', 'rating_tombstones', 'plan_identity']) {
      expect(tables).toContain(`store_${store}`)
    }
    const ledger = await runInDurableObject(roomStub(room), (_i, state) =>
      state.storage.sql.exec('SELECT version, name FROM schema_migrations ORDER BY version').toArray(),
    )
    expect(ledger).toHaveLength(2)
  })

  it('the json_valid CHECK makes a corrupt store write fail AT WRITE TIME', async () => {
    // workerd must ship the JSON1 functions the shared DDL relies on — if
    // it did not, migration 001 itself would fail and every case above
    // would already be red; this pins the CHECK's enforcement, not just
    // the DDL's acceptance.
    const room = nextRoom()
    const a = await dial(`/?op=create&room=${room}`)
    await a.expect('created')
    a.close()
    const result = await runInDurableObject(roomStub(room), (_i, state) => {
      try {
        state.storage.sql.exec("INSERT INTO store_plan (code, value, created_at, updated_at) VALUES (?, ?, 1, 1)", room, 'not json')
        return 'inserted'
      } catch {
        return 'refused'
      }
    })
    expect(result).toBe('refused')
  })

  it('a push lands as per-store rows, and the deprecated blob column stays NULL', async () => {
    const room = nextRoom()
    const a = await dial(`/?op=create&room=${room}`)
    await a.expect('created')
    a.send({ type: 'state', rev: 2, state: { plan: [{ variantId: 5 }], planIdentity: null } })
    await expectStoredRev(roomStub(room), 2)
    a.close()

    const rows = await runInDurableObject(roomStub(room), (_i, state) => ({
      plan: state.storage.sql.exec('SELECT value FROM store_plan WHERE code = ?', room).toArray(),
      identity: state.storage.sql.exec('SELECT value FROM store_plan_identity WHERE code = ?', room).toArray(),
      cleared: state.storage.sql.exec('SELECT value FROM store_cleared WHERE code = ?', room).toArray(),
      blob: state.storage.sql.exec('SELECT state FROM room WHERE code = ?', room).toArray(),
    }))
    expect(rows.plan).toEqual([{ value: '[{"variantId":5}]' }])
    // An explicit `planIdentity: null` is a PRESENT value and is written
    // through as the JSON text 'null' (ADR-0088 §3 addendum).
    expect(rows.identity).toEqual([{ value: 'null' }])
    // Absent keys insert no row at all — don't-touch, not a wipe.
    expect(rows.cleared).toHaveLength(0)
    // The deprecated column is never written again.
    expect(rows.blob).toEqual([{ state: null }])
  })

  it('migration 002 splits a legacy room.state blob into per-store rows', async () => {
    const room = nextRoom()
    // A database in the shape the Durable Object shipped BEFORE ADR-0088:
    // legacy room table (no updated_at, no store tables), one row whose
    // whole snapshot sits in the `state` blob.
    await runInDurableObject(roomStub(room), (_i, state) => {
      state.storage.sql.exec(`
        CREATE TABLE room (
          id INTEGER PRIMARY KEY,
          code TEXT NOT NULL,
          rev INTEGER NOT NULL,
          state TEXT,
          created_at INTEGER NOT NULL,
          last_activity INTEGER NOT NULL,
          inactivity_at INTEGER NOT NULL,
          idle_at INTEGER NOT NULL,
          serial INTEGER NOT NULL
        );
        CREATE TABLE rev_floor (code TEXT PRIMARY KEY, rev INTEGER NOT NULL, at INTEGER NOT NULL);
        CREATE TABLE peer_serial (code TEXT PRIMARY KEY, serial INTEGER NOT NULL);
      `)
      state.storage.sql.exec(
        `INSERT INTO room (id, code, rev, state, created_at, last_activity, inactivity_at, idle_at, serial)
         VALUES (1, ?, 5, ?, 111, 222, ?, ?, 2)`,
        room,
        JSON.stringify({
          plan: [{ variantId: 9, servings: 4 }],
          checked: { '12|butter': true },
          planIdentity: null,
          favorites: { '3': { favorited: true, updatedAt: 42 } },
        }),
        Date.now() + 60_000,
        Date.now() + 60_000,
      )
      state.storage.sql.exec('INSERT INTO rev_floor (code, rev, at) VALUES (?, 5, 222)', room)
      // The migration path under test must run WITHOUT a room write (a
      // socket event would touch the room and restamp its metadata), so
      // the migrations are pulled in by the alarm's tick instead.
      state.storage.setAlarm(Date.now() + 500)
    })
    await runDurableObjectAlarm(roomStub(room))

    // The split, stamped from the backfilled room row: created_at from the
    // room's creation, updated_at from 001's guarded-ALTER backfill
    // (last_activity), untouched by any socket event.
    const split = await runInDurableObject(roomStub(room), (_i, state) => ({
      plan: state.storage.sql.exec('SELECT value FROM store_plan WHERE code = ?', room).toArray(),
      planMeta: state.storage.sql
        .exec('SELECT created_at, updated_at FROM store_plan WHERE code = ?', room)
        .toArray(),
      favorites: state.storage.sql.exec('SELECT value FROM store_favorites WHERE code = ?', room).toArray(),
      identity: state.storage.sql.exec('SELECT value FROM store_plan_identity WHERE code = ?', room).toArray(),
      ratings: state.storage.sql.exec('SELECT value FROM store_ratings WHERE code = ?', room).toArray(),
      blob: state.storage.sql.exec('SELECT state FROM room WHERE code = ?', room).toArray(),
      updated: state.storage.sql.exec('SELECT updated_at FROM room WHERE code = ?', room).toArray(),
      ledger: state.storage.sql.exec('SELECT version FROM schema_migrations ORDER BY version').toArray(),
    }))
    expect(split.plan).toEqual([{ value: '[{"variantId":9,"servings":4}]' }])
    expect(split.favorites).toHaveLength(1)
    expect(split.identity).toEqual([{ value: 'null' }])
    // A key the blob did not carry inserted no row.
    expect(split.ratings).toHaveLength(0)
    // The blob column is kept, deprecated, NULL afterwards.
    expect(split.blob).toEqual([{ state: null }])
    // 001's guarded ALTER backfilled updated_at from last_activity.
    expect(split.updated).toEqual([{ updated_at: 222 }])
    expect(split.planMeta).toEqual([{ created_at: 111, updated_at: 222 }])
    expect(split.ledger).toEqual([{ version: 1 }, { version: 2 }])

    // The split is a round-trip: the joiner adopts the blob's stores.
    const a = await dial(`/?op=join&room=${room}`)
    const joined = await a.expect('joined')
    a.close()

    // The split is a round-trip: the joiner adopts the blob's stores.
    expect(joined).toMatchObject({
      rev: 5,
      state: {
        plan: [{ variantId: 9, servings: 4 }],
        checked: { '12|butter': true },
        planIdentity: null,
        favorites: { '3': { favorited: true, updatedAt: 42 } },
      },
    })

    const after = await runInDurableObject(roomStub(room), (_i, state) => ({
      plan: state.storage.sql.exec('SELECT value FROM store_plan WHERE code = ?', room).toArray(),
      planMeta: state.storage.sql
        .exec('SELECT created_at, updated_at FROM store_plan WHERE code = ?', room)
        .toArray(),
      favorites: state.storage.sql.exec('SELECT value FROM store_favorites WHERE code = ?', room).toArray(),
      identity: state.storage.sql.exec('SELECT value FROM store_plan_identity WHERE code = ?', room).toArray(),
      ratings: state.storage.sql.exec('SELECT value FROM store_ratings WHERE code = ?', room).toArray(),
      blob: state.storage.sql.exec('SELECT state FROM room WHERE code = ?', room).toArray(),
      updated: state.storage.sql.exec('SELECT updated_at FROM room WHERE code = ?', room).toArray(),
    }))
    expect(after.plan).toEqual([{ value: '[{"variantId":9,"servings":4}]' }])
    expect(after.favorites).toHaveLength(1)
    expect(after.identity).toEqual([{ value: 'null' }])
    // A key the blob did not carry inserted no row.
    expect(after.ratings).toHaveLength(0)
  })
})

describe('protocol strictness', () => {
  it('answers bad_json for a frame that is not JSON', async () => {
    const room = nextRoom()
    const a = await dial(`/?op=create&room=${room}`)
    await a.expect('created')
    a.ws.send('not json')
    expect(await a.expect('error')).toMatchObject({ code: 'bad_json' })
    a.close()
  })

  it('answers unknown_type for a message the room does not speak', async () => {
    const room = nextRoom()
    const a = await dial(`/?op=create&room=${room}`)
    await a.expect('created')
    a.send({ type: 'nonsense' })
    expect(await a.expect('error')).toMatchObject({ code: 'unknown_type' })
    a.close()
  })

  it('a re-asserted create/join for THIS room is answered, not dropped', async () => {
    const room = nextRoom()
    const a = await dial(`/?op=create&room=${room}`)
    await a.expect('created')
    a.send({ type: 'create', code: room })
    expect(await a.expect('created')).toMatchObject({ code: room })
    a.send({ type: 'join', code: room })
    expect(await a.expect('joined')).toMatchObject({ code: room })
    a.send({ type: 'join', code: 'some-other-room-xyz' })
    expect(await a.expect('error')).toMatchObject({ code: 'unknown_type' })
    a.close()
  })
})
describe('presence (ADR-0063)', () => {
  const UUID_A = '018f1a2b-3c4d-7e8f-9a0b-1c2d3e4f5a6b'
  const UUID_B = '018f1a2b-3c4d-7e8f-9a0b-1c2d3e4f5a6c'

  /** Dials WITH a room-identity profile (pid/pname on the upgrade URL). */
  async function dialWithProfile(
    room: string,
    id: string,
    name: string,
    op: 'create' | 'join' = 'create',
  ): Promise<Peer> {
    return dial(`/?op=${op}&room=${room}&pid=${id}&pname=${encodeURIComponent(name)}`)
  }

  /** Rosters are a SET of people; getWebSockets() order is not insertion order. */
  function sortedRoster(members: unknown): { id: string | null; name: string }[] {
    return (members as { id: string | null; name: string }[]).slice().sort((x, y) =>
      (x.id ?? '').localeCompare(y.id ?? ''),
    )
  }

  it('the first roster fan-out already lists the joiner (no Guest flash)', async () => {
    const room = nextRoom()
    const a = await dialWithProfile(room, UUID_A, 'Brave Otter')
    expect(await a.expect('created')).toMatchObject({ count: 1 })
    const peers = await a.expect('peers')
    expect(peers).toMatchObject({ count: 1 })
    expect(peers.members).toEqual([{ id: UUID_A, name: 'Brave Otter' }])
    a.close()
  })

  it('a profile-less (old-version) peer is a Guest row; the badge counts SOCKETS', async () => {
    const room = nextRoom()
    const a = await dialWithProfile(room, UUID_A, 'Brave Otter')
    await a.expect('created')
    await a.expect('peers') // a's own admission fan-out

    // An old client: no pid/pname, no profile claim anywhere.
    const legacy = await dial(`/?op=join&room=${room}`)
    await legacy.expect('joined')
    const frame = await a.expect('peers')
    expect(frame).toMatchObject({ count: 2 }) // two SOCKETS...
    expect(sortedRoster(frame.members)).toEqual([
      { id: null, name: 'Guest' }, // only one person has a name...
      { id: UUID_A, name: 'Brave Otter' }, // ...the badge still counts two sockets
    ])
    a.close()
    legacy.close()
  })

  it('dedupes two tabs of one device into ONE roster row, while the badge counts both sockets', async () => {
    const room = nextRoom()
    const a = await dialWithProfile(room, UUID_A, 'Brave Otter')
    await a.expect('created')
    await a.expect('peers')
    // Same device, second tab: same profile id, a NEW socket.
    const b = await dialWithProfile(room, UUID_A, 'Brave Otter', 'join')
    await b.expect('joined')
    const frame = await a.expect('peers')
    expect(frame).toMatchObject({ count: 2 }) // sockets
    expect(frame.members).toEqual([{ id: UUID_A, name: 'Brave Otter' }]) // people
    a.close()
    b.close()
  })

  it('a rename re-fans the roster with the new name, and an id on the frame is ignored', async () => {
    const room = nextRoom()
    const a = await dialWithProfile(room, UUID_A, 'Brave Otter')
    await a.expect('created')
    await a.expect('peers')

    a.send({ type: 'profile', name: 'Swift Marmot', id: UUID_B })
    const frame = await a.expect('peers')
    expect(frame.members).toEqual([{ id: UUID_A, name: 'Swift Marmot' }])
    a.close()
  })

  it("a rename is authoritative for the device's OTHER tab (review: no stale sibling name)", async () => {
    const room = nextRoom()
    const a = await dialWithProfile(room, UUID_A, 'Brave Otter')
    await a.expect('created')
    await a.expect('peers')
    // Same device, second tab: same profile id, a NEW socket that stays
    // connected and does NOT send anything itself.
    const b = await dialWithProfile(room, UUID_A, 'Brave Otter', 'join')
    await b.expect('joined')
    await a.expect('peers') // b's admission

    // The SECOND tab renames: the dedupe keeps the first socket's profile,
    // so without propagation a's attachment would keep the stale name.
    b.send({ type: 'profile', name: 'Swift Marmot' })
    const frame = await a.expect('peers')
    expect(frame).toMatchObject({ count: 2 })
    expect(frame.members).toEqual([{ id: UUID_A, name: 'Swift Marmot' }])

    // And it survives hibernation: the sibling attachments were
    // re-serialized, so a later fan-out still shows the new name.
    const c = await dial(`/?op=join&room=${room}`)
    await c.expect('joined')
    const refan = await a.expect('peers')
    expect(sortedRoster(refan.members)).toEqual([
      { id: null, name: 'Guest' },
      { id: UUID_A, name: 'Swift Marmot' },
    ])
    a.close()
    b.close()
    c.close()
  })

  it('the roster survives hibernation: a departure re-fan still lists the profile', async () => {
    const room = nextRoom()
    const a = await dialWithProfile(room, UUID_A, 'Brave Otter')
    await a.expect('created')
    await a.expect('peers')
    const b = await dialWithProfile(room, UUID_B, 'Calm Ferret', 'join')
    await b.expect('joined')
    await a.expect('peers') // b's admission

    // b leaves; the runtime reaps the socket BEFORE the close handler runs,
    // so a's next fan-out is rebuilt from the attachments of the REMAINING
    // sockets — a's own, hibernated.
    b.close()
    const frame = await a.expect('peers')
    expect(frame).toMatchObject({ count: 1 })
    expect(frame.members).toEqual([{ id: UUID_A, name: 'Brave Otter' }])
    a.close()
  })

  it('a state push from a profiled socket is attributed to the PROFILE id', async () => {
    const room = nextRoom()
    const a = await dialWithProfile(room, UUID_A, 'Brave Otter')
    await a.expect('created')
    const b = await dialWithProfile(room, UUID_B, 'Calm Ferret', 'join')
    await b.expect('joined')
    await a.expect('peers')

    a.send({ type: 'state', rev: 1, state: { plan: [] } })
    expect(await b.expect('state')).toMatchObject({ rev: 1, from: UUID_A })
    a.close()
    b.close()
  })

  it('a state push from a legacy socket still carries the serial as `from`', async () => {
    const room = nextRoom()
    const a = await dialWithProfile(room, UUID_A, 'Brave Otter')
    await a.expect('created')
    const b = await dial(`/?op=join&room=${room}`)
    await b.expect('joined')
    await a.expect('peers')

    b.send({ type: 'state', rev: 1, state: { plan: [] } })
    expect(await a.expect('state')).toMatchObject({ rev: 1, from: 'p2' })
    a.close()
    b.close()
  })
})
