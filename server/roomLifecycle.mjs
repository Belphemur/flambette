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
 * - two expiry clocks per room: a 1h INACTIVITY clock and the older 12h
 *   IDLE backstop. BOTH are refreshed by any liveness signal —
 *   keepalive included (review F1: a connected peer that keepalives is
 *   definitionally not an idle room, so a 12h-connected household must
 *   not be closed by the backstop). The 12h clock is therefore a
 *   redundant safety net that only matters if the 1h path ever breaks;
 *   the effective rule is "1h without keepalive or state traffic".
 *   Firing either closes the room and tells its peers `room_expired`.
 * - a socket belongs to AT MOST ONE room: `attachPeer` detaches it from
 *   its previous room first (review F3), so a peer can never linger in
 *   a room it left and then be told that room expired.
 * - `rev` is monotone PER CODE, not per room instance (review F4): the
 *   highest rev a code ever reached is kept for as long as the idle TTL
 *   and is handed back in `created`/`joined`, so a room re-created after
 *   an empty-room delete cannot restart at rev 1 and be mistaken for
 *   "newer than what this household already has".
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
  now = () => Date.now(),
} = {}) {
  /** code -> { code, peers:Set, rev, state, idleTimer, inactivityTimer } */
  const rooms = new Map()
  /**
   * code -> { rev, at }: the highest rev this code ever reached, kept
   * across room deletion for `idleTtlMs` (review F4). Bounded by
   * staleness pruning on read/write, so it cannot grow without limit.
   */
  const revFloor = new Map()

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

  /** Restart the 1h inactivity clock. */
  function touchActivity(room) {
    clearTimer(room.inactivityTimer)
    room.inactivityTimer = setTimer(() => expireRoom(room.code, 'inactive'), inactivityTtlMs)
  }

  /**
   * Restart BOTH clocks. Every liveness signal funnels through here —
   * create, join, state AND keepalive (review F1). The two clocks are
   * now refreshed by the same events, so 12h is pure defence in depth;
   * "1h of silence closes the room" is the promise the client relies on.
   */
  function touchRoom(room) {
    touchActivity(room)
    clearTimer(room.idleTimer)
    room.idleTimer = setTimer(() => expireRoom(room.code, 'idle'), idleTtlMs)
  }

  /**
   * Highest rev this code ever reached (0 when unknown or older than the
   * idle TTL). Prunes the entry on the way through.
   */
  function floorRev(code) {
    const entry = revFloor.get(code)
    if (!entry) return 0
    if (now() - entry.at > idleTtlMs) {
      revFloor.delete(code)
      return 0
    }
    return entry.rev
  }

  /**
   * Store a peer snapshot and keep the per-code floor moving. The floor
   * is what makes a re-created room continue the household's revision
   * history instead of restarting at 0 (review F4).
   *
   * ADR-0032: an opted-out sender legitimately omits `cookedHistory` —
   * absence means "don't touch" (ADR-0028's member rule), never "wipe the
   * household's cooking log". This store is what a LATER JOINER adopts,
   * so a wholesale replace on a keyless snapshot would strand the cooks
   * every sharing peer pushed: the room would answer `joined` with no
   * history at all. When the sender did not send the key, carry the
   * previously stored history into the stored snapshot. A sharing sender
   * always sends the key (even empty), so it still replaces wholesale and
   * can never resurrect rows the sender itself dropped.
   */
  function noteState(room, rev, state) {
    room.rev = rev
    room.state =
      state.cookedHistory === undefined && room.state?.cookedHistory !== undefined
        ? { ...state, cookedHistory: room.state.cookedHistory }
        : state
    const entry = revFloor.get(room.code)
    if (!entry || rev > entry.rev || now() - entry.at > idleTtlMs) {
      revFloor.set(room.code, { rev, at: now() })
    } else {
      entry.at = now()
    }
  }

  function newRoom(code) {
    const room = { code, peers: new Set(), idleTimer: null, inactivityTimer: null }
    rooms.set(code, room)
    touchRoom(room)
    return room
  }

  function createRoom(forcedCode = '') {
    if (forcedCode) return newRoom(forcedCode)
    let code = mintCode()
    while (rooms.has(code)) code = mintCode()
    return newRoom(code)
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
   * client re-joins — which re-creates the room — and re-seeds it. The
   * per-code `rev` floor survives (review F4).
   */
  function removePeer(ws, room) {
    if (!room) return
    room.peers.delete(ws)
    if (ws?.data) ws.data.roomCode = undefined
    if (room.peers.size === 0) dropRoom(room.code)
  }

  /**
   * Put a socket into a room, leaving any previous one first (review F3).
   * Without the detach, a socket that creates/joins somewhere else stays
   * in the old room's peer set, and that room's later expiry would send
   * it a terminal `room_expired` while it is happily live elsewhere — and
   * a later `leave`/`close` would delete a room it no longer belongs to.
   */
  function attachPeer(ws, room) {
    const previous = ws?.data?.roomCode ? rooms.get(ws.data.roomCode) : undefined
    if (previous && previous !== room) removePeer(ws, previous)
    room.peers.add(ws)
    if (ws?.data) ws.data.roomCode = room.code
    return room
  }

  return {
    rooms,
    createRoom,
    joinOrCreate,
    get,
    removePeer,
    attachPeer,
    touchRoom,
    touchActivity,
    noteState,
    floorRev,
    dropRoom,
    expireRoom,
  }
}
