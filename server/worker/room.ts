/**
 * `Room` — one Durable Object per room code (ADR-0038), on the shared core
 * (ADR-0040).
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
 * WHAT IS STILL HERE is only the half ADR-0040 leaves to the adapter: the
 * SQL rows, the alarm, and the hibernating WebSocket lifecycle. Every
 * decision — admission, the rev floor, which snapshot keys are preserved,
 * which clock fires first, whether a push is even admissible — comes from
 * `../relay-core`, which is where the Bun adapter gets the same answers.
 *
 * What the in-memory relay expressed with a Map and a `setTimeout` becomes
 * a SQL row and an alarm:
 *
 * - the room row (rev, state JSON, created_at, last_activity, both
 *   deadlines, a peer serial);
 * - the per-code floor row, which OUTLIVES the room row and is handed back
 *   in `created`/`joined` so a room re-created after an expiry cannot
 *   restart the household's revision history at zero (review F4).
 *
 * ONE alarm, armed at the earlier of the two deadlines. workerd gives a
 * hibernated object no timers at all, so a `setTimeout` here would simply
 * not fire once the object went idle — an alarm is the only clock that
 * survives eviction.
 *
 * SCOPED DEVIATION (ADR-0038 §4): when the last peer leaves, this relay
 * KEEPS the room row. The Bun relay deletes a room nobody is in; here the
 * state survives until the expiry clocks fire, so a phone that reconnects
 * after a tunnel or a reload gets its plan back instead of re-seeding an
 * empty room. The deviation is one line — `leave` is simply never called.
 */

import { DurableObject } from 'cloudflare:workers'
import {
  createRoomRegistry,
  normalizeProfile,
  normalizeProfileName,
  peersFrame,
  renamedProfile,
  type FloorRecord,
  type PeerProfile,
  type RoomRecord,
  type RoomRegistry,
  type RoomStore,
} from '../relay-core/lifecycle'
import { IDLE_TTL_MS, INACTIVITY_TTL_MS } from '../relay-core/policy'
import { parseClientFrame, RELAY_ERRORS, type RelayErrorCode, type RelayMessage } from '../relay-core/protocol'
import { canonicalizeCode } from '../relay-core/codes'
import {
  applyMigrations,
  ROOM_DELETE_SQL,
  ROOM_UPSERT_SQL,
  storeClearSql,
  storeRowSql,
  storeUpsertSql,
  type MigrationDatabase,
} from '../relay-core/migrations'
import {
  createStoreWritePlanner,
  joinSnapshot,
  SYNCED_STORES,
} from '../relay-core/stores'
import { refuseSocket } from './refuseSocket'
import type { ExpiryReason } from '../relay-core/lifecycle'

/**
 * What `deserializeAttachment` carries: this socket's peer identity AND
 * its room-identity profile (ADR-0063). The attachment SURVIVES
 * hibernation — that is the whole point of keeping presence in it: a
 * hibernated WebSocket is still a CONNECTED peer, and no SQL row is
 * needed to remember who it is.
 */
interface PeerAttachment {
  id: string
  code: string
  /** Null = a profile-less (old-version) peer: a Guest roster row. */
  profile: PeerProfile | null
}

/**
 * The schema is no longer declared here: migration 001 in
 * `../relay-core/migrations.ts` owns the DDL — the SAME statements the Bun
 * relay runs (ADR-0088 §2/§4) — and this object applies the shared list
 * lazily on its first event (workerd gives an object no `ctx.storage`
 * before the first event, so "at startup" does not exist here). The old
 * ad-hoc `CREATE TABLE IF NOT EXISTS` dance — which already produced the
 * peer_serial workaround once — is gone; the peer serial's two-table
 * shape is now part of the shared, versioned schema.
 */

export class Room extends DurableObject<Env> {
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

  /**
   * The shared core, built over this object's SQL store. Recreated per
   * event rather than cached in a field: the instance is cheap, the core
   * is a few closures, and a field would have to survive hibernation to
   * be worth it.
   */
  get #room(): RoomRegistry {
    return createRoomRegistry({
      code: this.#code,
      store: this.#store,
      inactivityTtlMs: INACTIVITY_TTL_MS,
      idleTtlMs: IDLE_TTL_MS,
      now: () => Date.now(),
      arm: (deadline) => this.ctx.storage.setAlarm(deadline),
      onExpire: (_code, reason) => this.#notifyExpired(reason),
    })
  }

  /* ---------------------------------------------------------------- schema */

  /**
   * Apply the SHARED migration list (ADR-0088 §4), lazily — workerd gives
   * an object no `ctx.storage` before the first event, so "at startup"
   * does not exist on this runtime. The runner verifies its steps against
   * the actual database rather than trusting a ledger, which is what the
   * old per-call `#ensureTables` probe insisted on and why there is no
   * `#schemaReady` flag here: storage isolation (the vitest pool rolls
   * each test's storage back) and any future storage reset can leave an
   * object looking at a database without its tables. Cheap when
   * converged: the runner is a few indexed reads over an in-process
   * SQLite.
   */
  #ensureSchema(): void {
    applyMigrations(this.#db, () => Date.now())
  }

  /**
   * The migration runner's facade over this object's storage SQL. Every
   * adapter call funnels through here; the cursor is materialised because
   * the runner may run further statements before reading it again.
   */
  get #db(): MigrationDatabase {
    return {
      exec: (sql, ...bindings) => {
        this.ctx.storage.sql.exec(sql, ...(bindings as unknown as SqlStorageValue[]))
      },
      all: (sql, ...bindings) =>
        [
          ...this.ctx.storage.sql.exec(sql, ...(bindings as unknown as SqlStorageValue[])),
        ] as unknown as Record<string, unknown>[],
    }
  }

  /**
   * One row, or undefined. `one()` THROWS on an empty result, which would
   * turn every "is there a room?" check into an exception, so the row is
   * pulled through `next()` and its `done` flag is the emptiness check.
   */
  #one(query: string, ...bindings: SqlStorageValue[]): Record<string, SqlStorageValue> | undefined {
    this.#ensureSchema()
    const step = this.ctx.storage.sql
      .exec<Record<string, SqlStorageValue>>(query, ...bindings)
      .next()
    return step.done ? undefined : step.value
  }

  /* ----------------------------------------------------------------- store */

  /**
   * The core's storage INTENTS over this object's per-store tables — the
   * whole "adapter owns state" half of ADR-0040. Since ADR-0088 §2 the
   * state is split across one table per synchronized store, using the
   * shared split/merge and the shared row SQL the core owns; this object
   * only binds its code and stamps the rows.
   */
  get #store(): RoomStore {
    return {
      read: () => this.#readRoom(),
      write: (row) => this.#writeRoom(row),
      drop: () => {
        this.#ensureSchema()
        this.ctx.storage.sql.exec(ROOM_DELETE_SQL, this.#code)
        for (const store of SYNCED_STORES) {
          this.ctx.storage.sql.exec(storeClearSql(store), this.#code)
        }
        // The room is gone; its remembered texts are dead weight (kody
        // review) — the planner stays bounded by the live room set.
        this.#planner.forget(this.#code)
      },
      readFloor: () => this.#readFloor(),
      writeFloor: (record) => this.#writeFloor(record),
      dropFloor: () => {
        this.#ensureSchema()
        this.ctx.storage.sql.exec('DELETE FROM rev_floor WHERE code = ?', this.#code)
        this.ctx.storage.sql.exec('DELETE FROM peer_serial WHERE code = ?', this.#code)
      },
    }
  }

  #readRoom(): RoomRecord | null {
    const row = this.#one(
      'SELECT code, rev, created_at, updated_at, last_activity, inactivity_at, idle_at, serial FROM room WHERE code = ?',
      this.#code,
    )
    if (!row) return null
    // The store rows ARE the snapshot now; the deprecated `room.state`
    // column (always NULL past migration 002) is never read back. One
    // statement per store — workerd's storage SQL rejects a compound
    // SELECT with one branch per table.
    const stores = SYNCED_STORES.map((store) => ({
      store,
      text: (
        [
          ...this.ctx.storage.sql.exec(storeRowSql(store), this.#code),
        ] as { text?: unknown }[]
      )[0]?.text,
    })) as unknown as { store: string; text: string | null }[]
    // Seed change detection with what is on disk (ADR-0088 §2): the first
    // touch after an eviction must not rewrite every store either.
    this.#planner.seed(this.#code, stores)
    return {
      code: String(row.code),
      rev: Number(row.rev),
      state: joinSnapshot(stores),
      createdAt: Number(row.created_at),
      lastActivityAt: Number(row.last_activity),
      inactivityAt: Number(row.inactivity_at),
      idleAt: Number(row.idle_at),
      serial: Number(row.serial),
    }
  }

  /**
   * The core's per-store change detection (ADR-0088 §2), one decision
   * consumed identically by the Bun adapter. Seeded by `#readRoom` (the
   * core only ever writes a record it just read, so the seed is warm even
   * after this isolate is evicted and a fresh one starts cold).
   */
  readonly #planner = createStoreWritePlanner()

  #writeRoom(row: RoomRecord): void {
    this.#ensureSchema()
    this.ctx.storage.sql.exec(
      ROOM_UPSERT_SQL,
      row.code,
      row.rev,
      row.createdAt,
      Date.now(),
      row.lastActivityAt,
      row.inactivityAt,
      row.idleAt,
      row.serial,
    )
    // The room row moved (its clocks genuinely changed); the store rows
    // only move when their VALUE did (kody review): a keepalive must not
    // re-upsert the unchanged stores and drag every `updated_at`
    // along. The core's plan says which rows changed; a `state: null`
    // write (a fresh establishment) clears every row. `created_at` is
    // "first write": the upsert preserves it. Same as the Bun adapter's
    // writeStoreRows.
    const plan = this.#planner.plan(row.code, row.state)
    if (plan.clearAll) {
      for (const store of SYNCED_STORES) {
        this.ctx.storage.sql.exec(storeClearSql(store), this.#code)
      }
      return
    }
    for (const { store, text } of plan.changed) {
      this.ctx.storage.sql.exec(
        storeUpsertSql(store),
        row.code,
        text,
        Date.now(),
        Date.now(),
      )
    }
  }

  #readFloor(): FloorRecord | null {
    const row = this.#one('SELECT * FROM rev_floor WHERE code = ?', this.#code)
    if (!row) return null
    return {
      code: String(row.code),
      rev: Number(row.rev),
      at: Number(row.at),
      serial: this.#readSerial(),
    }
  }

  #writeFloor(record: FloorRecord): void {
    this.#ensureSchema()
    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO rev_floor (code, rev, at) VALUES (?, ?, ?)',
      record.code,
      record.rev,
      record.at,
    )
    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO peer_serial (code, serial) VALUES (?, ?)',
      record.code,
      record.serial,
    )
  }

  /** The peer serial, or 0 for a room created before the table existed. */
  #readSerial(): number {
    const row = this.#one('SELECT serial FROM peer_serial WHERE code = ?', this.#code)
    return row ? Number(row.serial) : 0
  }

  /* ---------------------------------------------------------------- sockets */

  #send(ws: WebSocket, payload: RelayMessage): void {
    try {
      ws.send(JSON.stringify(payload))
    } catch {
      // A socket that died between the fan-out and this send is not an
      // error: the close handler already reaped it.
    }
  }

  #fail(ws: WebSocket, code: RelayErrorCode): void {
    this.#send(ws, { type: 'error', code })
  }

  /**
   * Refuse the socket: answer with a relay error and close. These are
   * still WebSockets, not rejected handshakes — the client's room UI is
   * driven by relay messages, so an HTTP 4xx here would surface as a bare
   * "connection failed" instead of "that code is taken".
   */
  #refuse(client: WebSocket, server: WebSocket, code: RelayErrorCode): Response {
    // The accept-before-refuse subtlety and the handshake completion
    // live in the one shared helper (see refuseSocket.ts).
    return refuseSocket(client, server, code)
  }

  /**
   * Tell every hibernated peer how many of them there are (ADR-0049) and
   * who exactly they are (ADR-0063).
   *
   * The count itself is the CORE's (`livePeers + 1` on the admission
   * verdict); walking the peer set is the adapter's, because
   * `ctx.getWebSockets()` is the Durable Object's only notion of "live
   * peer" — the Bun relay walks a `Set` instead. The ROSTER is rebuilt
   * the same way, from each socket's serialized attachment, which is
   * why presence lives there: it survives hibernation with no SQL. A
   * refused socket is never hibernated (`#refuse` uses `accept()`), so
   * it cannot appear in the roster; a socket that died mid-send is
   * guarded by `#send`'s try/catch.
   */
  #broadcastPeers(): void {
    const sockets = this.ctx.getWebSockets()
    const frame = peersFrame(
      sockets.length,
      sockets.map((ws) => this.#profileOf(ws)),
    )
    for (const peer of sockets) this.#send(peer, frame)
  }

  /** A socket's profile, read from its attachment (null when unparseable). */
  #profileOf(ws: WebSocket): PeerProfile | null {
    try {
      const attachment = ws.deserializeAttachment() as PeerAttachment | null
      return attachment?.profile ?? null
    } catch {
      // An attachment the runtime cannot deserialize is a Guest row, not
      // a crash in the fan-out's path.
      return null
    }
  }

  /**
   * Hibernatable accept, tagged with this peer's id AND its room-identity
   * profile (ADR-0063) — the attachment is where presence survives
   * hibernation. The serial comes from the core, which keeps it monotone
   * across a re-creation of this code, so an id is never handed out
   * twice within a code's history.
   */
  #acceptPeer(server: WebSocket, code: string, profile: PeerProfile | null): string {
    const id = `p${this.#room.nextSerial()}`
    this.ctx.acceptWebSocket(server, [id])
    server.serializeAttachment({ id, code, profile } satisfies PeerAttachment)
    return id
  }

  /**
   * Tell every peer the room is gone, BEFORE the core drops the row. The
   * client treats `room_expired` as TERMINAL — a re-join would
   * join-or-create an empty room and read as silent household data loss.
   */
  #notifyExpired(reason: ExpiryReason): void {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(JSON.stringify({ type: 'error', code: RELAY_ERRORS.roomExpired, reason }))
        ws.close(1000, RELAY_ERRORS.roomExpired)
      } catch {
        // Already gone; the close handler reaped it.
      }
    }
  }

  /* ------------------------------------------------------------------ fetch */

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
    const code = canonicalizeCode(url.searchParams.get('room')) || this.#code
    // ADR-0063: the join/create profile rides the SAME upgrade URL as the
    // intent (pid/pname, forwarded by the worker entry), so the very
    // first roster fan-out is already complete.
    const profile = normalizeProfile({
      id: url.searchParams.get('pid') ?? undefined,
      name: url.searchParams.get('pname') ?? undefined,
    })

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]

    const verdict = this.#room.admit(mode, this.ctx.getWebSockets().length)
    if (verdict.kind === 'refuse') return this.#refuse(client, server, verdict.error)

    this.#acceptPeer(server, code, profile)
    if (verdict.kind === 'establish') {
      // `created` carries the code's rev FLOOR, never the room's current
      // rev: the client seeds above it, so a re-created room cannot pass a
      // stale snapshot off as newer (review F4).
      this.#send(server, { type: 'created', code: verdict.code, rev: verdict.rev, count: verdict.count })
    } else {
      this.#send(server, { type: 'joined', code: verdict.code, rev: verdict.rev, state: verdict.state, count: verdict.count })
    }
    // Everyone learns the new headcount, the joiner included (its own
    // frame already carries it; the fan-out keeps the rest in step).
    this.#broadcastPeers()
    return new Response(null, { status: 101, webSocket: client })
  }

  /* --------------------------------------------------------------- message */

  /**
   * A message off a hibernating socket. Woken objects never pass through
   * `fetch`, so this is where the room rules are applied — by the core.
   */
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    this.#ensureSchema()
    const attachment = ws.deserializeAttachment() as PeerAttachment | null
    const member = !!attachment && attachment.code === this.#code && attachment.id.startsWith('p')

    // The frame gate lives in the core (ADR-0040): unparseable bytes AND
    // a parsed non-object frame are refused `bad_json` on both relays.
    const frame = parseClientFrame(raw)
    if (!frame.ok) {
      this.#fail(ws, frame.error)
      return
    }
    const msg = frame.msg

    switch (msg.type) {
      case 'keepalive': {
        // Never throttled: it carries no guessable input and must not be
        // able to burn a create/join budget. The core refreshes BOTH
        // clocks, so a 7-day-connected household is never closed by the
        // idle backstop (review F1).
        if (!member || this.#room.keepalive().kind !== 'ok') {
          this.#fail(ws, RELAY_ERRORS.notInRoom)
          return
        }
        this.#send(ws, { type: 'keepalive_ack' })
        return
      }

      case 'state': {
        // Review F2: MEMBERSHIP, not just the code. A socket that was
        // refused (code_taken / not_found) must not write into the room
        // it was aiming at. The Bun relay answers a non-member's state
        // with bad_state (the membership check is folded into the same
        // guard), so the two relays speak the same reply here.
        // ADR-0063: the fan-out `from` is the SENDER's profile id when it
        // has one, the per-code serial otherwise (legacy peers).
        const from = attachment?.profile?.id ?? attachment?.id ?? ''
        const verdict = member
          ? this.#room.push(msg.rev, msg.state, from)
          : { ok: false as const, error: RELAY_ERRORS.badState as RelayErrorCode }
        if (!verdict.ok) {
          this.#fail(ws, verdict.error)
          return
        }
        for (const peer of this.ctx.getWebSockets()) {
          if (peer === ws) continue
          this.#send(peer, verdict.fanOut)
        }
        return
      }

      case 'profile': {
        // A mid-session rename (ADR-0063). The id is FIXED at join — any
        // `id` on this frame is ignored — so only the name moves, and the
        // re-serialized attachment is what the roster survives on.
        if (!member) {
          this.#fail(ws, RELAY_ERRORS.notInRoom)
          return
        }
        if (attachment?.profile) {
          const name = normalizeProfileName(msg.name)
          const id = attachment.profile.id
          attachment.profile = { ...attachment.profile, name }
          ws.serializeAttachment(attachment)
          // A rename is authoritative for EVERY socket sharing the identity
          // (ADR-0063 dedupe): a device's second tab renaming must not leave
          // the first tab's stale name as the roster's row for that person
          // (review — the dedupe keeps the FIRST socket's profile). The
          // attachments are where presence survives hibernation, so each
          // sibling socket re-serializes too.
          for (const peer of this.ctx.getWebSockets()) {
            if (peer === ws) continue
            try {
              const sibling = peer.deserializeAttachment() as PeerAttachment | null
              if (!sibling) continue
              const next = renamedProfile(sibling.profile ?? null, id, name)
              if (next && next !== sibling.profile) {
                sibling.profile = next
                peer.serializeAttachment(sibling)
              }
            } catch {
              // An unreadable attachment is a Guest row, not a rename blocker.
            }
          }
          this.#broadcastPeers()
        } else if (normalizeProfile(msg)) {
          // First contact from a client that never carried a profile at
          // upgrade: adopt id + name, verbatim from the frame. This is the
          // socket's FIRST adoption, not a later change, so the "id fixed
          // at join" rule still holds.
          attachment!.profile = normalizeProfile(msg)
          ws.serializeAttachment(attachment)
          this.#broadcastPeers()
        }
        return
      }

      case 'leave': {
        this.#send(ws, { type: 'left' })
        ws.close(1000, 'left')
        // The peer is still hibernated at this point (its close handler runs
        // after), so the count is broadcast from `webSocketClose` once the
        // runtime has actually reaped it. Announcing `size - 1` here would
        // be right by arithmetic and wrong in fact if the socket did not
        // close cleanly.
        return
      }

      case 'create':
      case 'join': {
        // The worker entry carries the intent in the upgrade URL, so
        // these are not part of the documented vocabulary any more. They
        // are still answered rather than dropped when they re-assert THIS
        // room (an old client that only knows how to say so), and refused
        // otherwise: a socket cannot move rooms, and a different code
        // would need a different Durable Object entirely. A profile on
        // the frame (ADR-0063) is adopted on FIRST contact, like the Bun
        // adapter's message form.
        if (member && !attachment?.profile) {
          const adopted = normalizeProfile(msg.profile)
          if (adopted) {
            attachment!.profile = adopted
            ws.serializeAttachment(attachment)
            this.#broadcastPeers()
          }
        }
        const asked = canonicalizeCode(msg.code)
        const row = member && asked === this.#code ? this.#readRoom() : null
        if (!row) {
          this.#fail(ws, RELAY_ERRORS.unknownType)
          return
        }
        this.#send(
          ws,
          msg.type === 'create'
            ? { type: 'created', code: this.#code, rev: this.#room.floor(), count: this.ctx.getWebSockets().length }
            : { type: 'joined', code: this.#code, rev: row.rev, state: row.state, count: this.ctx.getWebSockets().length },
        )
        return
      }

      default:
        this.#fail(ws, RELAY_ERRORS.unknownType)
    }
  }

  /* ----------------------------------------------------------------- alarms */

  /**
   * Expiry. The core reads the row, decides which of the two clocks fired
   * (and re-arms the alarm when a keepalive moved the deadline), notifies
   * the peers through `onExpire` and drops the row. The floor row
   * deliberately stays, so the household's revision history outlives the
   * room until the idle TTL prunes it.
   */
  async alarm(): Promise<void> {
    this.#ensureSchema()
    this.#room.tick()
  }

  /* ------------------------------------------------------------------ close */

  /**
   * A peer left. Deliberately a no-op beyond the peer count: ADR-0038 §4
   * keeps the room row until the clocks fire, so a phone that reloads
   * mid-cook comes back to its plan — which is also why `leave` is never
   * called on the core from here. The runtime has already removed this
   * socket from the hibernation set by the time the handler runs, so
   * `getWebSockets().length` is the headcount AFTER the departure
   * (ADR-0049). With nobody left there is no recipient for the frame, and
   * the DO will be evicted with the row still on its expiry clocks.
   */
  async webSocketClose(ws: WebSocket): Promise<void> {
    if (this.ctx.getWebSockets().length > 0) this.#broadcastPeers()
  }

  /** Same story as close: a dropped transport is not a room deletion. */
  async webSocketError(ws: WebSocket): Promise<void> {
    void ws
  }
}