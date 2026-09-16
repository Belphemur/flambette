/**
 * Mealime Planner — live room relay.
 *
 * A tiny in-memory WebSocket relay: rooms keyed by a 6-char code, clients
 * share a whole-state document with last-write-wins semantics (the client
 * owns conflict resolution via monotonic `rev` numbers — the relay only
 * stores and fans out).
 *
 * No database, no persistence: rooms expire after 12h of inactivity.
 * Heartbeat ping/pong every 30s prunes dead sockets.
 *
 * Run: `node server/relay.mjs` (listens on :8081, override with PORT env).
 */
import { WebSocketServer } from 'ws'

const PORT = Number(process.env.PORT ?? 8081)
const IDLE_TTL_MS = 12 * 60 * 60 * 1000 // rooms expire after 12h idle
const HEARTBEAT_MS = 30_000

/**
 * Room codes: 6 chars, Crockford base32 minus vowels (no A/E/I/L/O/U)
 * so codes never accidentally spell or contain words.
 */
const CODE_ALPHABET = '0123456789BCDFGHJKLMNPQRSTVWXZ'
const CODE_LENGTH = 6

const rooms = new Map()

/** Monotonic peer id for attribution on fan-out (informational only). */
let nextPeerId = 0

function makeCode() {
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
  }
  return code
}

function scheduleExpiry(code) {
  return setTimeout(() => rooms.delete(code), IDLE_TTL_MS)
}

function createRoom() {
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
  ws.roomCode = undefined
  // State deliberately stays in memory even when the room empties —
  // a returning peer can still join until idle expiry.
}

function send(ws, payload) {
  if (ws.readyState === 1 /* OPEN */) ws.send(JSON.stringify(payload))
}

const wss = new WebSocketServer({ port: PORT })
console.log(`[relay] listening on :${PORT}`)

wss.on('connection', (ws) => {
  ws.isAlive = true
  ws.peerId = `p${++nextPeerId}`
  ws.on('pong', () => {
    ws.isAlive = true
  })

  ws.on('message', (data) => {
    let msg
    try {
      msg = JSON.parse(data.toString())
    } catch {
      send(ws, { type: 'error', code: 'bad_json' })
      return
    }

    switch (msg.type) {
      case 'create': {
        const room = createRoom()
        room.peers.add(ws)
        ws.roomCode = room.code
        touchRoom(room)
        send(ws, { type: 'created', code: room.code })
        break
      }

      case 'join': {
        const code = typeof msg.code === 'string' ? msg.code.trim().toUpperCase() : ''
        const room = rooms.get(code)
        if (!room) {
          send(ws, { type: 'error', code: 'not_found' })
          return
        }
        room.peers.add(ws)
        ws.roomCode = room.code
        touchRoom(room)
        send(ws, { type: 'joined', code: room.code, state: room.state ?? null })
        break
      }

      case 'state': {
        const room = ws.roomCode ? rooms.get(ws.roomCode) : undefined
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
          if (peer !== ws) send(peer, { type: 'state', rev, state: msg.state, from: ws.peerId })
        }
        break
      }

      case 'leave': {
        if (ws.roomCode) {
          const room = rooms.get(ws.roomCode)
          if (room) removePeer(ws, room)
        }
        send(ws, { type: 'left' })
        break
      }

      default:
        send(ws, { type: 'error', code: 'unknown_type' })
    }
  })

  ws.on('close', () => {
    if (ws.roomCode) {
      const room = rooms.get(ws.roomCode)
      if (room) removePeer(ws, room)
    }
  })
})

/** Prune dead sockets: a missed pong (30s) marks the socket, the next beat terminates it. */
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate()
      continue
    }
    ws.isAlive = false
    ws.ping()
  }
}, HEARTBEAT_MS)

wss.on('close', () => clearInterval(heartbeat))
wss.on('error', (err) => {
  console.error(`[relay] ${err.message}`)
  process.exit(1)
})
