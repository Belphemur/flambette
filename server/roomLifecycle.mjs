/**
 * Room lifecycle for the Mealime relay: codes, room storage, the two
 * expiry clocks and the peer/room bookkeeping around them.
 *
 * Extracted from server/relay.mjs (mirroring ./throttle.mjs) so the
 * lifecycle rules are unit-testable without a live socket:
 *
 * - `join` is JOIN-OR-CREATE: the first client to arrive establishes the
 *   room under the code it asked for (ADR-0026) instead of getting
 *   `not_found`. This is what makes a room creatable by whoever shows up
 *   first — the owner's explicit ask.
 * - a room whose LAST peer leaves is deleted immediately, so "nobody is
 *   there" never needs to wait for a timer (its state goes with it; the
 *   returning client re-seeds the room on `joined`).
 * - two expiry clocks per room: a 1h INACTIVITY clock, refreshed only by
 *   application-level `keepalive` / `state` traffic, and the older 12h
 *   IDLE backstop refreshed by any interaction at all. Firing either
 *   closes the room and tells its peers `room_expired`.
 *
 * Plain ESM JavaScript with injectable clock/timers/code generator so
 * the relay keeps running as a zero-dep Bun script and the unit specs
 * can pin time.
 */

import { randomInt } from 'node:crypto'

/** Rooms close after 1h with no keepalive and no state activity (ADR-0026). */
export const INACTIVITY_TTL_MS = Number(process.env.RELAY_INACTIVITY_TTL_MS ?? 60 * 60 * 1000)

/** Backstop TTL for a room whose peers vanished without `leave`. */
export const IDLE_TTL_MS = Number(process.env.RELAY_IDLE_TTL_MS ?? 12 * 60 * 60 * 1000)

/**
 * Room codes have two accepted shapes (ADR-0021):
 * - the current one: three lowercase words, `amber-falcon-lantern`,
 *   rolled CLIENT-side so the user can read it before joining.
 * - the legacy one: 4-12 chars compacted and upper-cased, minted by the
 *   relay from a Crockford base32 alphabet with all vowels removed so
 *   codes never spell words.
 */
export const CODE_ALPHABET = '0123456789BCDFGHJKLMNPQRSTVWXZ'
export const CODE_LENGTH = 6
export const WORD_CODE_RE = /^[a-z]{3,10}-[a-z]{3,10}-[a-z]{3,10}$/

/**
 * Canonicalize any accepted code so `join` finds the room whichever
 * shape/spelling the peer used. Mirrors `normalizeRoomCode` in
 * src/lib/roomWords.ts: a 3-word code lowercased, anything else
 * alphanumeric compacted and upper-cased (the legacy storage shape).
 * A PARTIAL word code is refused (empty string), never coerced.
 */
export function normalizeCode(raw) {
  if (typeof raw !== 'string') return ''
  const tokens = raw.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  if (tokens.length === 3 && tokens.every((t) => /^[a-z]{3,10}$/.test(t))) return tokens.join('-')
  if (tokens.length === 1 && /^[a-z0-9]{4,12}$/.test(tokens[0])) return tokens[0].toUpperCase()
  return ''
}

/** Legacy relay-minted code. crypto.randomInt, not Math.random (qodo 4128519648). */
export function makeCode() {
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  }
  return code
}

/**
 * The in-memory room registry. `onExpire(room, reason)` is called with
 * `reason` 'inactive' | 'idle' just BEFORE the room is dropped, so the
 * relay can tell the peers to stop reconnecting.
 */
export function createRoomRegistry({
  inactivityTtlMs = INACTIVITY_TTL_MS,
  idleTtlMs = IDLE_TTL_MS,
  mintCode = makeCode,
  onExpire = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  /** code -> { code, peers:Set, rev, state, idleTimer, inactivityTimer } */
  const rooms = new Map()

  function dropRoom(code) {
    const room = rooms.get(code)
    if (!room) return
    clearTimer(room.inactivityTimer)
    clearTimer(room.idleTimer)
    rooms.delete(code)
  }

  function expireRoom(code, reason) {
    const room = rooms.get(code)
    if (!room) return
    try {
      onExpire(room, reason)
    } catch (err) {
      // A misbehaving peer sink must never keep the room (or the
      // process) alive; expiry has already happened by contract.
      console.error(`[relay] expire hook failed for ${code}: ${err?.message ?? err}`)
    }
    dropRoom(code)
  }

  /** Restart the 1h inactivity clock (keepalive / state traffic). */
  function touchActivity(room) {
    clearTimer(room.inactivityTimer)
    room.inactivityTimer = setTimer(() => expireRoom(room.code, 'inactive'), inactivityTtlMs)
  }

  /** Restart BOTH clocks — any interaction counts (create/join/keepalive/state). */
  function touchRoom(room) {
    touchActivity(room)
    clearTimer(room.idleTimer)
    room.idleTimer = setTimer(() => expireRoom(room.code, 'idle'), idleTtlMs)
  }

  function createRoom(forcedCode = '') {
    if (forcedCode) {
      const room = { code: forcedCode, peers: new Set(), idleTimer: null, inactivityTimer: null }
      rooms.set(forcedCode, room)
      touchRoom(room)
      return room
    }
    let code = mintCode()
    while (rooms.has(code)) code = mintCode()
    const room = { code, peers: new Set(), idleTimer: null, inactivityTimer: null }
    rooms.set(code, room)
    touchRoom(room)
    return room
  }

  /**
   * Join-or-create (ADR-0026). Returns `{ room, created }` so the relay
   * can answer `created` for the peer that established the room and
   * `joined` (with the room's current state) for everyone else. An
   * unusable code yields `{ room: null, created: false }` — the caller
   * answers `not_found`, which the client maps to "not a room code".
   */
  function joinOrCreate(rawCode) {
    const code = normalizeCode(rawCode)
    if (!code) return { room: null, created: false }
    const existing = rooms.get(code)
    if (existing) {
      touchRoom(existing)
      return { room: existing, created: false }
    }
    return { room: createRoom(code), created: true }
  }

  function get(code) {
    return code ? rooms.get(code) : undefined
  }

  /**
   * Drop a peer. The room is DELETED when its last peer leaves (ADR-0026):
   * nobody is there, so the room (and its state) goes too. A returning
   * client re-joins — which re-creates the room — and re-seeds it.
   */
  function removePeer(ws, room) {
    if (!room) return
    room.peers.delete(ws)
    if (ws?.data) ws.data.roomCode = undefined
    if (room.peers.size === 0) dropRoom(room.code)
  }

  return {
    rooms,
    createRoom,
    joinOrCreate,
    get,
    removePeer,
    touchRoom,
    touchActivity,
    dropRoom,
    expireRoom,
  }
}
