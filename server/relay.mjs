/**
 * Mealime Planner — live room relay.
 *
 * A tiny in-memory WebSocket relay: rooms keyed by a 6-char code, clients
 * share a whole-state document with last-write-wins semantics (the client
 * owns conflict resolution via monotonic `rev` numbers — the relay only
 * stores and fans out).
 *
 * Zero dependencies: runs on Bun's native WebSocket support (Bun.serve).
 * No database, no persistence: rooms expire after 12h of inactivity.
 * Heartbeat ping/pong every 30s prunes dead sockets.
 *
 * Run: `bun server/relay.mjs` (listens on :8081, override with PORT env).
 */

import { randomInt } from 'node:crypto'

const PORT = Number(process.env.PORT ?? 8081)
const IDLE_TTL_MS = 12 * 60 * 60 * 1000 // rooms expire after 12h idle
const HEARTBEAT_MS = 30_000

import { makeThrottle, MemoryAttemptBuckets } from './throttle.mjs'

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
  peerAddress: (ws) => server?.requestIP?.(ws)?.address ?? 'unknown',
})


/**
 * Room codes have two accepted shapes (ADR-0021):
 * - the current one: three lowercase words, `amber-falcon-lantern`,
 *   rolled CLIENT-side so the user can read it before joining. The relay
 *   accepts it on `create` when the code is free, and answers
 *   `code_taken` otherwise (the client then re-rolls).
 * - the legacy one: 6 chars from Crockford base32 minus vowels (no
 *   A/E/I/L/O/U) so codes never accidentally spell or contain words.
 *   Still accepted for join, and still what `create` mints when the
 *   client asks for no particular code (older clients).
 */
const CODE_ALPHABET = '0123456789BCDFGHJKLMNPQRSTVWXZ'
const CODE_LENGTH = 6
const WORD_CODE_RE = /^[a-z]{3,10}-[a-z]{3,10}-[a-z]{3,10}$/

/**
 * Canonicalize any accepted code so `join` finds the room whichever
 * shape/spelling the peer used. Mirrors `normalizeRoomCode` in
 * src/lib/roomWords.ts: a 3-word code lowercased, anything else
 * alphanumeric compacted and upper-cased (the legacy storage shape).
 */
function normalizeCode(raw) {
  if (typeof raw !== 'string') return ''
  const tokens = raw.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  if (tokens.length === 3 && tokens.every((t) => /^[a-z]{3,10}$/.test(t))) return tokens.join('-')
  if (tokens.length === 1 && /^[a-z0-9]{4,12}$/.test(tokens[0])) return tokens[0].toUpperCase()
  return ''
}

const rooms = new Map()

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

function makeCode() {
  // crypto.randomInt, not Math.random (qodo 4128519648): uniform and
  // unpredictable — a comment elsewhere already claimed this.
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  }
  return code
}

function scheduleExpiry(code) {
  return setTimeout(() => rooms.delete(code), IDLE_TTL_MS)
}

function createRoom(forcedCode = '') {
  if (forcedCode) {
    const room = { code: forcedCode, peers: new Set(), idleTimer: scheduleExpiry(forcedCode) }
    rooms.set(forcedCode, room)
    return room
  }
  let code = makeCode()
  while (rooms.has(code)) code = makeCode()
  const room = { code, peers: new Set(), idleTimer: scheduleExpiry(code) }
  rooms.set(code, room)
  return room
}

/** Reset the idle clock for a room (called on any room activity). */
function touchRoom(room) {
  clearTimeout(room.idleTimer)
  room.idleTimer = scheduleExpiry(room.code)
}

function removePeer(ws, room) {
  room.peers.delete(ws)
  ws.data.roomCode = undefined
  // State deliberately stays in memory even when the room empties —
  // a returning peer can still join until idle expiry.
}

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
      if (srv.upgrade(req, { data: { isAlive: true, roomCode: undefined } })) return
      return new Response('mealime relay\n', { headers: { 'content-type': 'text/plain' } })
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
            const room = createRoom(wanted)
            room.peers.add(ws)
            ws.data.roomCode = room.code
            touchRoom(room)
            send(ws, { type: 'created', code: room.code })
            break
          }

          case 'join': {
            if (!throttle.allow(ws)) {
              send(ws, { type: 'error', code: 'rate_limited' })
              return
            }
            const code = normalizeCode(msg.code)
            const room = code ? rooms.get(code) : undefined
            if (!room) {
              send(ws, { type: 'error', code: 'not_found' })
              return
            }
            room.peers.add(ws)
            ws.data.roomCode = room.code
            touchRoom(room)
            send(ws, { type: 'joined', code: room.code, rev: room.rev ?? 0, state: room.state ?? null })
            break
          }

          case 'state': {
            const room = ws.data.roomCode ? rooms.get(ws.data.roomCode) : undefined
            const rev = msg.rev
            if (
              !room ||
              typeof rev !== 'number' ||
              !Number.isFinite(rev) ||
              typeof msg.state !== 'object' ||
              msg.state === null
            ) {
              send(ws, { type: 'error', code: 'bad_state' })
              return
            }
            room.rev = rev
            room.state = msg.state
            touchRoom(room)
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

console.log(`[relay] listening on :${PORT}`)

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