/**
 * Mealime Planner — live room relay.
 *
 * A tiny in-memory WebSocket relay: rooms keyed by a 6-char code, clients
 * share a whole-state document with last-write-wins semantics (the client
 * owns conflict resolution via monotonic `rev` numbers — the relay only
 * stores and fans out).
 *
 * Zero dependencies: runs on Bun's native WebSocket support (Bun.serve).
 * No database, no persistence. Room lifecycle (ADR-0026) lives in
 * ./roomLifecycle.mjs (unit-tested):
 * - `join` is join-or-create: the first client to arrive ESTABLISHES the
 *   room under the code it asked for, so a room is creatable by whoever
 *   shows up first instead of failing `not_found`.
 * - a room whose last peer leaves is deleted immediately.
 * - a room closes after 24h with no application-level `keepalive` and no
 *   state activity; the peers are told `room_expired` so they stop
 *   reconnecting. A 7-day idle TTL is the backstop for peers that vanished
 *   without a `leave` (ADR-0038, widening ADR-0026).
 *
 * Heartbeat ping/pong every 30s prunes dead SOCKETS — that is transport
 * liveness only and deliberately does NOT refresh room activity.
 *
 * Run: `bun server/relay.mjs` (listens on :8081, override with PORT env).
 */

const PORT = Number(process.env.PORT ?? 8081)
const HEARTBEAT_MS = 30_000

import { makeThrottle, MemoryAttemptBuckets } from './throttle.mjs'
import { createRoomRegistry, INACTIVITY_TTL_MS, IDLE_TTL_MS, WORD_CODE_RE } from './roomLifecycle.mjs'

/**
 * Brute-force throttle (qodo 4128519648): create/join attempts are
 * limited per socket AND per IP — an enumerated or guessed-code flood
 * burns the budget within one window and gets `rate_limited`. Applied
 * ONLY to create/join: ordinary state fan-out between joined peers is
 * never throttled. 30/min/IP still lets a household re-join freely
 * while capping blind enumeration of the 262k word-code space.
 * Logic lives in ./throttle.mjs (unit-tested); the relay just wires it.
 */
const throttle = makeThrottle({
  // The REAL peer IP, captured at upgrade time (see fetch below): per-IP
  // budgets are meaningless if every peer collapses into one shared
  // bucket — under the suite's own connection churn legitimate joins
  // started receiving `rate_limited` (224-test e2e run failed 4-9
  // room-join tests; raising RELAY_ATTEMPT_LIMIT made all of them pass,
  // which pins the shared-bucket collapse as the cause).
  peerAddress: (ws) => ws.data.ip ?? 'unknown',
})


/**
 * Room codes (both accepted shapes) and the whole room lifecycle —
 * see ./roomLifecycle.mjs and ADR-0021 / ADR-0026.
 */
const registry = createRoomRegistry({
  onExpire(room, reason) {
    // Tell every peer the room is gone BEFORE it is dropped, so the
    // client can stop reconnecting instead of rejoining a corpse.
    // Review F2/F3: only peers that are STILL in this room are notified,
    // and every one of them has its `roomCode` cleared here — a stale
    // socket that kept the code could still write state into (and
    // `leave`/close could delete) a room re-created under the same code.
    for (const peer of room.peers) {
      if (peer.data?.roomCode !== room.code) continue
      peer.data.roomCode = undefined
      send(peer, { type: 'error', code: 'room_expired', reason })
    }
  },
})
const { rooms } = registry

/** All live sockets (Bun has no iterable server.clients — track manually). */
const sockets = new Set()

/** Monotonic peer id for attribution on fan-out (informational only). */
let nextPeerId = 0

/**
 * One create/join attempt against BOTH the per-socket and per-IP
 * budgets. Delegates to ./throttle.mjs (unit-tested module).
 */
function allowAttempt(ws) {
  return throttle.allow(ws)
}

const removePeer = registry.removePeer

function send(ws, payload) {
  if (ws.readyState === 1 /* OPEN */) ws.send(JSON.stringify(payload))
}

let server
try {
  server = Bun.serve({
    port: PORT,
    // Plain HTTP responses so health probes (playwright webServer url check,
    // load balancers) get a 200; WebSocket upgrades are handed to the
    // websocket handler below.
    fetch(req, srv) {
      // Throttle key: the real CLIENT address. Behind the compose nginx
      // (nginx.conf /ws) the socket address is nginx's own container IP,
      // which would make every household share one 30/min budget — so the
      // forwarded header wins when present. Direct connections (dev relay,
      // LAN) carry no header and fall back to the socket address.
      // Trade-off, recorded in ADR-0024: the header is only trusted
      // because the relay is only ever reached through its own proxy;
      // a forged header on a direct connection shifts your own budget,
      // which is acceptable for household-grade anti-brute-force
      // hardening (it is not an ACL).
      const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      const ip =
        (forwarded || srv.requestIP(req)?.address) ?? 'unknown'
      if (srv.upgrade(req, { data: { isAlive: true, roomCode: undefined, ip } })) return
      // The health body echoes the lifecycle configuration so a test (or
      // an operator) can tell two relays apart without guessing: a
      // leftover listener from an earlier run with DIFFERENT TTLs must
      // never be mistaken for the one a spec asked for.
      return new Response(
        JSON.stringify({
          service: 'mealime-relay',
          inactivityTtlMs: INACTIVITY_TTL_MS,
          idleTtlMs: IDLE_TTL_MS,
          attemptLimit: throttle.limit,
        }),
        { headers: { 'content-type': 'application/json' } },
      )
    },
    websocket: {
      open(ws) {
        ws.data.peerId = `p${++nextPeerId}`
        sockets.add(ws)
      },

      message(ws, data) {
        let msg
        try {
          msg = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString())
        } catch {
          send(ws, { type: 'error', code: 'bad_json' })
          return
        }

        switch (msg.type) {
          case 'create': {
            if (!throttle.allow(ws)) {
              send(ws, { type: 'error', code: 'rate_limited' })
              return
            }
            // ADR-0021: the client rolls the three-word code itself so it
            // can show the user what to share. An already-taken code is
            // refused so the client can re-roll rather than silently
            // joining someone else's room.
            const wanted =
              typeof msg.code === 'string' && WORD_CODE_RE.test(msg.code.trim())
                ? msg.code.trim()
                : ''
            if (wanted && rooms.has(wanted)) {
              send(ws, { type: 'error', code: 'code_taken' })
              return
            }
            const room = registry.createRoom(wanted)
            registry.attachPeer(ws, room)
            // `rev` is the per-code floor (review F4): the client seeds
            // ABOVE it, so a room re-created after an empty-room delete
            // continues the household's revision history.
            send(ws, { type: 'created', code: room.code, rev: registry.floorRev(room.code) })
            break
          }

          case 'join': {
            if (!throttle.allow(ws)) {
              send(ws, { type: 'error', code: 'rate_limited' })
              return
            }
            // ADR-0026 join-or-create: whoever arrives first ESTABLISHES
            // the room under the code they asked for. This is what makes
            // a household room startable by any peer, and it is why the
            // "Room not found" dead end is gone. An unusable code shape
            // (partial word code, empty) still answers not_found.
            const { room, created } = registry.joinOrCreate(msg.code)
            if (!room) {
              send(ws, { type: 'error', code: 'not_found' })
              return
            }
            registry.attachPeer(ws, room)
            if (created) {
              // Fresh room: nothing shared yet, so `created` (the same
              // reply shape as the host path) makes the client seed it.
              send(ws, { type: 'created', code: room.code, rev: registry.floorRev(room.code) })
            } else {
              send(ws, { type: 'joined', code: room.code, rev: room.rev ?? 0, state: room.state ?? null })
            }
            break
          }

          case 'keepalive': {
            // Application-level liveness (ADR-0026). NOT throttled: it
            // carries no guessable input and must never be able to burn
            // a create/join budget. Distinct from the 30s socket ping,
            // which only prunes dead transports and deliberately does
            // not touch room activity. The answer is deliberately NOT
            // named 'pong': that name belongs to the socket-level beat.
            // …and it refreshes BOTH expiry clocks (review F1): a peer
            // that is connected and keepaliving is, by definition, not
            // an idle room — a 7-day-connected household must never be
            // closed by the idle backstop.
            const room = ws.data.roomCode ? registry.get(ws.data.roomCode) : undefined
            if (!room || !room.peers.has(ws)) {
              send(ws, { type: 'error', code: 'not_in_room' })
              return
            }
            registry.touchRoom(room)
            send(ws, { type: 'keepalive_ack' })
            break
          }

          case 'state': {
            const room = ws.data.roomCode ? rooms.get(ws.data.roomCode) : undefined
            const rev = msg.rev
            if (
              !room ||
              // Review F2: membership, not just the code. A socket whose
              // room expired (its roomCode was cleared) or that was
              // detached by a later join must not write into this room.
              !room.peers.has(ws) ||
              typeof rev !== 'number' ||
              !Number.isFinite(rev) ||
              typeof msg.state !== 'object' ||
              msg.state === null
            ) {
              send(ws, { type: 'error', code: 'bad_state' })
              return
            }
            registry.noteState(room, rev, msg.state)
            registry.touchRoom(room)
            for (const peer of room.peers) {
              if (peer !== ws) send(peer, { type: 'state', rev, state: msg.state, from: ws.data.peerId })
            }
            break
          }

          case 'leave': {
            if (ws.data.roomCode) {
              const room = rooms.get(ws.data.roomCode)
              if (room) removePeer(ws, room)
            }
            send(ws, { type: 'left' })
            break
          }

          default:
            send(ws, { type: 'error', code: 'unknown_type' })
        }
      },

      pong(ws) {
        ws.data.isAlive = true
      },

      close(ws) {
        sockets.delete(ws)
        if (ws.data?.roomCode) {
          const room = rooms.get(ws.data.roomCode)
          if (room) removePeer(ws, room)
        }
      },
    },
  })
} catch (err) {
  console.error(`[relay] ${err.message}`)
  process.exit(1)
}

console.log(
  `[relay] listening on :${PORT} (inactivity TTL ${Math.round(INACTIVITY_TTL_MS / 1000)}s, ` +
    `idle backstop TTL ${Math.round(IDLE_TTL_MS / 1000)}s)`,
)

/** Prune dead sockets: a missed pong (30s) marks the socket, the next beat terminates it. */
const heartbeat = setInterval(() => {
  for (const ws of sockets) {
    if (ws.data.isAlive === false) {
      ws.terminate()
      continue
    }
    ws.data.isAlive = false
    ws.ping()
  }
}, HEARTBEAT_MS)

process.on('exit', () => clearInterval(heartbeat))