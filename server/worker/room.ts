/**
 * `Room` — one Durable Object per room code (ADR-0038).
 *
 * The Bun relay kept rooms in a Map inside one process. The mapping onto a
 * DO is deliberately one-to-one: the code is the Durable Object's NAME,
 * so routing a socket to its room is `idFromName(code)` and two things
 * fall out for free instead of needing bookkeeping:
 *
 * - a socket belongs to AT MOST ONE room (review F3) — structurally, it
 *   is only ever handed to one stub;
 * - rooms are independent of each other's load — one busy household
 *   cannot stall another's storage operations.
 *
 * Everything the in-memory relay expressed with a Map and a setTimeout
 * becomes a SQL row and an alarm:
 *
 * - the room row (rev, state JSON, created_at, last_activity, both
 *   deadlines, a peer serial);
 * - the per-code `rev` floor row, which OUTLIVES the room row and is
 *   handed back in `created`/`joined` so a room re-created after an
 *   expiry cannot restart the household's revision history at zero
 *   (review F4);
 * - ONE alarm, armed at the earlier of the two deadlines. workerd gives
 *   a hibernated object no timers at all, so a `setTimeout` here would
 *   simply not fire once the object went idle — an alarm is the only
 *   clock that survives eviction.
 *
 * SCOPED DEVIATION (ADR-0038 §4): when the last peer leaves, this relay
 * KEEPS the room row. The Bun relay deletes a room nobody is in; here the
 * state survives until the expiry clocks fire, so a phone that
 * reconnects after a tunnel or a reload gets its plan back instead of
 * re-seeding an empty room.
 */

import { DurableObject } from 'cloudflare:workers'
import { IDLE_TTL_MS, INACTIVITY_TTL_MS, PRESERVED_WHEN_ABSENT } from '../relayPolicy.mjs'
import { normalizeRoomCode, RELAY_ERRORS } from './codes'

/** Columns of the single-room row. `id` is pinned to 1: one room per DO. */
interface RoomRow {
  code: string
  rev: number
  /** The last shared-state snapshot, JSON-encoded; null until first push. */
  state: string | null
  created_at: number
  last_activity: number
  /** Absolute deadline of the 24h inactivity clock. */
  inactivity_at: number
  /** Absolute deadline of the 7-day idle backstop. */
  idle_at: number
  /** Monotonic peer counter, so `state.from` is stable and unique. */
  serial: number
}

interface FloorRow {
  code: string
  rev: number
  at: number
}

/** What `deserializeAttachment` carries: this socket's peer identity. */
interface PeerAttachment {
  id: string
  code: string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS room (
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
CREATE TABLE IF NOT EXISTS rev_floor (
  code TEXT PRIMARY KEY,
  rev INTEGER NOT NULL,
  at INTEGER NOT NULL
);
`

const ROOM_ID = 1

export class Room extends DurableObject<Env> {
  /**
   * Guards the one-time DDL. `ctx.storage` is unavailable before the
   * first event reaches the object, and the object can be evicted between
   * any two events, so the schema is (re)checked lazily per instance
   * rather than once in the constructor.
   */
  #schemaReady = false

  /**
   * This object's room code, i.e. the name the worker entry derived it
   * from. The name is a property of the id rather than something the
   * worker has to remember, so it costs nothing to re-read after an
   * eviction; it is absent only for an id that was not built by
   * `idFromName`, which this relay never creates.
   */
  get #code(): string {
    return this.ctx.id.name ?? ''
  }

  #ensureSchema(): void {
    if (this.#schemaReady) return
    this.ctx.storage.sql.exec(SCHEMA)
    this.#schemaReady = true
  }

  /** Stored state is our own JSON; a corrupt row must not kill the room. */
  static #parseState(raw: string | null): Record<string, unknown> | null {
    if (raw === null) return null
    try {
      return JSON.parse(raw) as Record<string, unknown>
    } catch {
      return null
    }
  }

  /**
   * One row, or undefined. The generated cursor type claims a row is
   * always there; at runtime `one()` is undefined for an empty result, so
   * the emptiness check is spelled out once, here.
   */
  #one(query: string, ...bindings: SqlStorageValue[]): Record<string, SqlStorageValue> | undefined {
    this.#ensureSchema()
    const row = this.ctx.storage.sql
      .exec<Record<string, SqlStorageValue>>(query, ...bindings)
      .one() as Record<string, SqlStorageValue> | undefined
    return row ?? undefined
  }

  // ---------------------------------------------------------------- storage

  #readRoom(): RoomRow | null {
    const row = this.#one('SELECT * FROM room WHERE id = ?', ROOM_ID)
    if (!row) return null
    return {
      code: String(row.code),
      rev: Number(row.rev),
      state: row.state === null || row.state === undefined ? null : String(row.state),
      created_at: Number(row.created_at),
      last_activity: Number(row.last_activity),
      inactivity_at: Number(row.inactivity_at),
      idle_at: Number(row.idle_at),
      serial: Number(row.serial),
    }
  }

  #writeRoom(row: RoomRow): void {
    this.#ensureSchema()
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO room
        (id, code, rev, state, created_at, last_activity, inactivity_at, idle_at, serial)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ROOM_ID,
      row.code,
      row.rev,
      row.state,
      row.created_at,
      row.last_activity,
      row.inactivity_at,
      row.idle_at,
      row.serial,
    )
  }

  #readFloor(): FloorRow | null {
    const row = this.#one('SELECT * FROM rev_floor WHERE code = ?', this.#code)
    return row ? { code: String(row.code), rev: Number(row.rev), at: Number(row.at) } : null
  }

  #writeFloor(rev: number, at: number): void {
    this.#ensureSchema()
    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO rev_floor (code, rev, at) VALUES (?, ?, ?)',
      this.#code,
      rev,
      at,
    )
  }

  #dropFloor(): void {
    this.#ensureSchema()
    this.ctx.storage.sql.exec('DELETE FROM rev_floor WHERE code = ?', this.#code)
  }

  // ------------------------------------------------------------------ clocks

  /**
   * The canonical `rev` this code has reached (0 when unknown, or older
   * than the idle TTL — the entry is pruned on the way through, which is
   * what keeps the floor table bounded without an alarm of its own).
   */
  #floorRev(now: number): number {
    const entry = this.#readFloor()
    if (!entry) return 0
    if (now - entry.at > IDLE_TTL_MS) {
      this.#dropFloor()
      return 0
    }
    return entry.rev
  }

  /**
   * Record a rev, moving the floor forward when it is higher and
   * refreshing the floor's own age either way, so a busy household never
   * has its floor pruned underneath it.
   */
  #noteFloor(rev: number, now: number): void {
    const entry = this.#readFloor()
    if (!entry || rev > entry.rev || now - entry.at > IDLE_TTL_MS) {
      this.#writeFloor(rev, now)
      return
    }
    this.#writeFloor(entry.rev, now)
  }

  /**
   * Restart BOTH expiry clocks. Every liveness signal funnels through
   * here — create, join, state AND keepalive (review F1) — because a
   * connected peer that keepalives is by definition not an idle room.
   * The two deadlines are then one alarm at the earlier of them.
   */
  #armClocks(row: RoomRow, now: number): RoomRow {
    const next: RoomRow = {
      ...row,
      last_activity: now,
      inactivity_at: now + INACTIVITY_TTL_MS,
      idle_at: now + IDLE_TTL_MS,
    }
    this.ctx.storage.setAlarm(Math.min(next.inactivity_at, next.idle_at))
    return next
  }

  // ------------------------------------------------------------------ sockets

  #send(ws: WebSocket, payload: unknown): void {
    try {
      ws.send(JSON.stringify(payload))
    } catch {
      // A socket that died between the fan-out and this send is not an
      // error: the close handler already reaped it.
    }
  }

  #fail(ws: WebSocket, code: string): void {
    this.#send(ws, { type: 'error', code })
  }

  /**
   * Refuse the socket: answer with a relay error and close. These are
   * still WebSockets, not rejected handshakes — the client's room UI is
   * driven by relay messages, so an HTTP 4xx here would surface as a bare
   * "connection failed" instead of "that code is taken".
   */
  #refuse(client: WebSocket, server: WebSocket, code: string): Response {
    // `accept()` (not `ctx.acceptWebSocket`) is deliberate: a refused
    // socket is never hibernated, so it cannot linger in this room's
    // peer set and cannot be revived by a later message. The client end
    // is still what gets returned, which is what completes the handshake
    // and delivers the error.
    server.accept()
    try {
      server.send(JSON.stringify({ type: 'error', code }))
    } catch {
      // The peer is gone before the refusal could land; nothing to do.
    } finally {
      server.close(1000, code)
    }
    return new Response(null, { status: 101, webSocket: client })
  }

  /** Broadcast to every socket in this room EXCEPT the sender. */
  #fanOut(sender: WebSocket | null, payload: unknown): void {
    for (const peer of this.ctx.getWebSockets()) {
      if (peer === sender) continue
      this.#send(peer, payload)
    }
  }

  // ------------------------------------------------------------------- fetch

  /**
   * Entry point for an upgrade the worker entry has already validated,
   * throttled and routed here. `?mode=create|join&room=<canonical code>`.
   */
  async fetch(request: Request): Promise<Response> {
    this.#ensureSchema()
    const url = new URL(request.url)
    const mode = url.searchParams.get('mode') === 'create' ? 'create' : 'join'
    // The entry routed by name, so the code in the URL is already
    // canonical; re-deriving it keeps the row self-describing.
    const code = normalizeRoomCode(url.searchParams.get('room') ?? '') || this.#code
    const now = Date.now()

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]

    const existing = this.#readRoom()
    const livePeers = this.ctx.getWebSockets().length

    if (mode === 'create') {
      // A stored room that nobody is in is, logically, gone — the Bun
      // relay deletes it on last leave (ADR-0026), so a `create` lands on
      // a fresh room here too. What survives the deletion is the rev
      // FLOOR, and the `created` reply carries it.
      if (existing && livePeers > 0) return this.#refuse(client, server, RELAY_ERRORS.codeTaken)
      const floor = this.#floorRev(now)
      const row = this.#armClocks(
        {
          code,
          rev: floor,
          state: null,
          created_at: now,
          last_activity: now,
          inactivity_at: now + INACTIVITY_TTL_MS,
          idle_at: now + IDLE_TTL_MS,
          serial: 0,
        },
        now,
      )
      this.#acceptPeer(server, code, row.serial)
      this.#writeRoom(row)
      this.#send(server, { type: 'created', code, rev: floor })
      return new Response(null, { status: 101, webSocket: client })
    }

    // join
    if (!existing) return this.#refuse(client, server, RELAY_ERRORS.notFound)
    this.#acceptPeer(server, code, existing.serial)
    const touched = this.#armClocks(existing, now)
    this.#writeRoom(touched)
    this.#send(server, {
      type: 'joined',
      code,
      rev: touched.rev,
      state: Room.#parseState(touched.state),
    })
    return new Response(null, { status: 101, webSocket: client })
  }

  /** Hibernatable accept, tagged with this peer's id. */
  #acceptPeer(server: WebSocket, code: string, previousSerial: number): void {
    const id = `p${previousSerial + 1}`
    this.ctx.acceptWebSocket(server, [id])
    server.serializeAttachment({ id, code } satisfies PeerAttachment)
  }

  // ------------------------------------------------------------------ message

  /**
   * A message off a hibernating socket. Woken objects never pass through
   * `fetch`, so this is where the room rules live.
   */
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    this.#ensureSchema()
    const attachment = ws.deserializeAttachment() as PeerAttachment | null
    const member = !!attachment && attachment.code === this.#code && attachment.id.startsWith('p')

    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw))
    } catch {
      this.#fail(ws, RELAY_ERRORS.badJson)
      return
    }
    if (!msg || typeof msg !== 'object') {
      this.#fail(ws, RELAY_ERRORS.badJson)
      return
    }

    switch (msg.type) {
      case 'keepalive': {
        // Never throttled: it carries no guessable input and must not be
        // able to burn a create/join budget. It DOES refresh both clocks
        // (review F1).
        if (!member || !this.#readRoom()) {
          this.#fail(ws, RELAY_ERRORS.notInRoom)
          return
        }
        this.#writeRoom(this.#armClocks(this.#readRoom()!, Date.now()))
        this.#send(ws, { type: 'keepalive_ack' })
        return
      }

      case 'state': {
        const rev = msg.rev
        // Review F2: MEMBERSHIP, not just the code. A socket that was
        // refused (code_taken / not_found) must not write into the room
        // it was aiming at.
        if (
          !member ||
          !this.#readRoom() ||
          typeof rev !== 'number' ||
          !Number.isFinite(rev) ||
          typeof msg.state !== 'object' ||
          msg.state === null
        ) {
          this.#fail(ws, RELAY_ERRORS.badState)
          return
        }
        this.#commitState(rev, msg.state as Record<string, unknown>)
        this.#writeRoom(this.#armClocks(this.#readRoom()!, Date.now()))
        this.#fanOut(ws, { type: 'state', rev, state: msg.state, from: attachment!.id })
        return
      }

      case 'leave': {
        this.#send(ws, { type: 'left' })
        ws.close(1000, 'left')
        return
      }

      case 'create':
      case 'join': {
        // The worker entry carries the intent in the upgrade URL, so
        // these are not part of the documented vocabulary any more. They
        // are still answered rather than dropped when they re-assert THIS
        // room (an old client that only knows how to say so), and refused
        // otherwise: a socket cannot move rooms, and a different code
        // would need a different Durable Object entirely.
        const asked = normalizeRoomCode(typeof msg.code === 'string' ? msg.code : '')
        if (!member || !asked || asked !== this.#code || !this.#readRoom()) {
          this.#fail(ws, RELAY_ERRORS.unknownType)
          return
        }
        const row = this.#readRoom()!
        this.#send(
          ws,
          msg.type === 'create'
            ? { type: 'created', code: this.#code, rev: this.#floorRev(Date.now()) }
            : {
                type: 'joined',
                code: this.#code,
                rev: row.rev,
                state: Room.#parseState(row.state),
              },
        )
        return
      }

      default:
        this.#fail(ws, RELAY_ERRORS.unknownType)
    }
  }

  /**
   * Store a snapshot and move the floor. `cookedHistory` and
   * `planIdentity` are PRESERVED when the inbound snapshot omits them
   * (ADR-0032 / ADR-0034): an opted-out sender is silent about history,
   * never a wipe, and an explicit `planIdentity: null` really does mean
   * "no current plan", so only an ABSENT key carries the stored value
   * forward. This store is what a later joiner adopts, which is exactly
   * why a wholesale replace would be destructive.
   */
  #commitState(rev: number, state: Record<string, unknown>): void {
    const now = Date.now()
    const row = this.#readRoom()
    const previous = Room.#parseState(row?.state ?? null)
    let next = state
    for (const key of PRESERVED_WHEN_ABSENT) {
      if (state[key] === undefined && previous?.[key] !== undefined) {
        if (next === state) next = { ...state }
        next[key] = previous[key]
      }
    }
    if (row) {
      this.#writeRoom({ ...row, rev, state: JSON.stringify(next) })
    }
    this.#noteFloor(rev, now)
  }

  // ------------------------------------------------------------------- alarms

  /**
   * Expiry. One alarm, armed at the earlier deadline: whichever clock
   * fired first closes the room, tells every peer `room_expired` (the
   * client treats that as TERMINAL — a re-join would join-or-create an
   * empty room and read as silent household data loss) and deletes the
   * room row. The floor row deliberately stays, so the household's
   * revision history outlives the room until the idle TTL prunes it.
   */
  async alarm(): Promise<void> {
    this.#ensureSchema()
    const now = Date.now()
    const row = this.#readRoom()

    if (!row) {
      this.#pruneFloor(now)
      return
    }

    const deadline = Math.min(row.inactivity_at, row.idle_at)
    if (now < deadline) {
      // Touched (a keepalive re-armed it) since the alarm was set.
      this.ctx.storage.setAlarm(deadline)
      return
    }

    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(JSON.stringify({ type: 'error', code: RELAY_ERRORS.roomExpired }))
        ws.close(1000, RELAY_ERRORS.roomExpired)
      } catch {
        // Already gone; the close handler reaped it.
      }
    }
    this.ctx.storage.sql.exec('DELETE FROM room WHERE id = ?', ROOM_ID)
    this.#pruneFloor(now)
  }

  /** The floor outlives the room; it dies with the idle TTL. */
  #pruneFloor(now: number): void {
    const entry = this.#readFloor()
    if (entry && now - entry.at > IDLE_TTL_MS) this.#dropFloor()
  }

  // -------------------------------------------------------------------- close

  /**
   * A peer left. Deliberately a no-op beyond what the runtime already
   * did: ADR-0038 §4 keeps the room row until the clocks fire, so a
   * phone that reloads mid-cook comes back to its plan. The only thing
   * left to do is make sure the room is not holding an alarm for a room
   * that is still alive — which it legitimately is.
   */
  async webSocketClose(ws: WebSocket): Promise<void> {
    void ws
  }

  /** Same story as close: a dropped transport is not a room deletion. */
  async webSocketError(ws: WebSocket): Promise<void> {
    void ws
  }
}
