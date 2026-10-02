import { describe, expect, test } from 'bun:test'
import {
  createRoomRegistry,
  normalizeCode,
  makeCode,
  INACTIVITY_TTL_MS,
  IDLE_TTL_MS,
  CODE_ALPHABET,
} from '../../server/roomLifecycle.mjs'

/**
 * Deterministic clock + timer harness: `setTimer(fn, ms)` arms a callback
 * at `now + ms`; `advance(ms)` moves the clock forward, running every
 * callback that comes due in deadline order (each one seeing a clock that
 * already includes the delay it waited) — so re-armed timers behave
 * exactly as they do with real setTimeout.
 */
function fakeClock() {
  let now = 0
  let seq = 0
  /** @type {Map<number, {at:number, fn:()=>void}>} */
  const armed = new Map()
  return {
    setTimer(fn: () => void, ms: number) {
      const id = ++seq
      armed.set(id, { at: now + ms, fn })
      return id
    },
    clearTimer(id: number) {
      armed.delete(id)
    },
    advance(ms: number) {
      const target = now + ms
      for (;;) {
        const due = [...armed]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at)
        if (!due.length) break
        const [id, t] = due[0]
        armed.delete(id)
        now = t.at
        t.fn()
      }
      now = target
    },
    nextDeadline(): number | null {
      const deadlines = [...armed.values()].map((t) => t.at)
      return deadlines.length ? Math.min(...deadlines) : null
    },
  }
}

function harness(overrides: Record<string, unknown> = {}) {
  const timers = fakeClock()
  const expired: { code: string; reason: string }[] = []
  const clock = { t: 1_000_000 }
  const registry = createRoomRegistry({
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    now: () => clock.t,
    mintCode: () => 'AAA111',
    onExpire: (room: { code: string }, reason: string) => expired.push({ code: room.code, reason }),
    ...overrides,
  })
  return { registry, timers, expired, clock }
}

const ws = (peerId: number) => ({ data: { peerId, roomCode: undefined as string | undefined } })

describe('relay room codes', () => {
  test('defaults: 24h inactivity, 7-day idle backstop (ADR-0038 widening ADR-0026)', () => {
    expect(INACTIVITY_TTL_MS).toBe(24 * 60 * 60 * 1000)
    expect(IDLE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000)
  })

  test('normalizeCode canonicalizes both ADR-0021 shapes', () => {
    expect(normalizeCode('Mauve-Peacock-Candle')).toBe('mauve-peacock-candle')
    expect(normalizeCode('mauve peacock candle')).toBe('mauve-peacock-candle')
    expect(normalizeCode('mauve_peacock_candle')).toBe('mauve-peacock-candle')
    expect(normalizeCode('abc123')).toBe('ABC123')
    expect(normalizeCode('a-b-c')).toBe('') // 3 tokens, but not word-shaped each
    expect(normalizeCode('mauve-peacock-candlex')).toBe('mauve-peacock-candlex')
  })

  test('normalizeCode refuses a PARTIAL word code instead of coercing it', () => {
    expect(normalizeCode('mauve-peacock')).toBe('')
    expect(normalizeCode('mauve-peacock-candle-extra')).toBe('')
    expect(normalizeCode('')).toBe('')
    expect(normalizeCode('!!!')).toBe('')
    expect(normalizeCode(undefined)).toBe('')
  })

  test('makeCode mints a 6-char legacy code free of vowels', () => {
    for (let i = 0; i < 50; i++) {
      const code = makeCode()
      expect(code).toMatch(/^[0-9BCDFGHJKLMNPQRSTVWXZ]{6}$/)
      for (const v of 'AEIOU') expect(code).not.toContain(v)
    }
    expect(CODE_ALPHABET).toHaveLength(30) // 10 digits + 20 letters
    expect(CODE_ALPHABET).not.toMatch(/[AEIOU]/)
  })
})

describe('join-or-create (ADR-0026)', () => {
  test('the first joiner ESTABLISHES the room (no not_found)', () => {
    const { registry } = harness()
    const a = ws(1)
    const { room, created } = registry.joinOrCreate('mauve-peacock-candle')
    expect(created).toBe(true)
    expect(room!.code).toBe('mauve-peacock-candle')
    room!.peers.add(a)
    a.data.roomCode = room!.code
  })

  test('the second joiner joins the SAME room with created=false', () => {
    const { registry } = harness()
    const first = registry.joinOrCreate('mauve-peacock-candle')
    const second = registry.joinOrCreate('Mauve-Peacock-Candle')
    expect(second.created).toBe(false)
    expect(second.room).toBe(first.room)
    expect(registry.rooms.size).toBe(1)
  })

  test('an unusable code shape yields no room (relay answers not_found)', () => {
    const { registry } = harness()
    expect(registry.joinOrCreate('mauve-peacock')).toEqual({ room: null, created: false })
    expect(registry.rooms.size).toBe(0)
  })

  test('create() is unchanged: honours a free word code, else mints', () => {
    const { registry } = harness()
    expect(registry.createRoom('jade-otter-lantern').code).toBe('jade-otter-lantern')
    expect(registry.createRoom().code).toBe('AAA111')
  })
})

describe('empty rooms are deleted (ADR-0026)', () => {
  test('the room survives while a peer remains and dies with the last one', () => {
    const { registry } = harness()
    const a = ws(1)
    const b = ws(2)
    const room = registry.joinOrCreate('mauve-peacock-candle').room!
    room.peers.add(a)
    room.peers.add(b)
    a.data.roomCode = room.code
    b.data.roomCode = room.code

    registry.removePeer(a, room)
    expect(registry.rooms.size).toBe(1)
    expect(registry.get('mauve-peacock-candle')).toBe(room)

    registry.removePeer(b, room)
    expect(registry.rooms.size).toBe(0)
    expect(registry.get('mauve-peacock-candle')).toBeUndefined()
    expect(b.data.roomCode).toBeUndefined()
  })

  test('a deleted room re-creates on the next join (self-healing)', () => {
    const { registry } = harness()
    const room = registry.joinOrCreate('mauve-peacock-candle').room!
    const a = ws(1)
    room.peers.add(a)
    a.data.roomCode = room.code
    registry.removePeer(a, room)

    const again = registry.joinOrCreate('mauve-peacock-candle')
    expect(again.created).toBe(true)
    expect(again.room).not.toBe(room)
  })

  test('removePeer with no room is a no-op (socket close before join)', () => {
    const { registry } = harness()
    expect(() => registry.removePeer(ws(9), undefined as never)).not.toThrow()
  })
})

describe('expiry clocks (ADR-0026)', () => {
  test('a room with no keepalive is closed after the inactivity window', () => {
    const { registry, timers, expired } = harness()
    const a = ws(1)
    const room = registry.joinOrCreate('mauve-peacock-candle').room!
    room.peers.add(a)

    timers.advance(INACTIVITY_TTL_MS - 1)
    expect(registry.get('mauve-peacock-candle')).toBe(room)
    timers.advance(1)
    expect(registry.rooms.size).toBe(0)
    expect(expired).toEqual([{ code: 'mauve-peacock-candle', reason: 'inactive' }])
  })

  test('keepalive pushes the inactivity deadline out indefinitely', () => {
    const { registry, timers, expired } = harness()
    const room = registry.joinOrCreate('mauve-peacock-candle').room!
    room.peers.add(ws(1))

    for (let minute = 0; minute < 5; minute++) {
      timers.advance(60_000)
      registry.touchActivity(room) // what `keepalive` does
    }
    expect(registry.get('mauve-peacock-candle')).toBe(room)
    expect(expired).toEqual([])
    // Still armed, one full window after the LAST keepalive.
    expect(timers.nextDeadline()).toBe(5 * 60_000 + INACTIVITY_TTL_MS)
  })

  test('state traffic also refreshes activity (touchRoom refreshes both clocks)', () => {
    const { registry, timers, expired } = harness()
    const room = registry.joinOrCreate('mauve-peacock-candle').room!
    room.peers.add(ws(1))
    timers.advance(INACTIVITY_TTL_MS - 1)
    registry.touchRoom(room) // what `state` does
    timers.advance(1)
    expect(registry.get('mauve-peacock-candle')).toBe(room)
    expect(expired).toEqual([])
  })

  test('the idle backstop fires with reason=idle', () => {
    const { registry, timers, expired } = harness({ inactivityTtlMs: 10 * IDLE_TTL_MS })
    registry.joinOrCreate('mauve-peacock-candle')
    timers.advance(IDLE_TTL_MS)
    expect(registry.rooms.size).toBe(0)
    expect(expired).toEqual([{ code: 'mauve-peacock-candle', reason: 'idle' }])
  })

  test('a throwing expire hook still drops the room (expiry always wins)', () => {
    const { registry, timers } = harness({
      onExpire: () => {
        throw new Error('peer sink exploded')
      },
    })
    registry.joinOrCreate('mauve-peacock-candle')
    expect(() => timers.advance(INACTIVITY_TTL_MS)).not.toThrow()
    expect(registry.rooms.size).toBe(0)
  })

  test('dropRoom/expireRoom on an unknown code are no-ops', () => {
    const { registry, expired } = harness()
    expect(() => registry.dropRoom('nope')).not.toThrow()
    expect(() => registry.expireRoom('nope', 'inactive')).not.toThrow()
    expect(expired).toEqual([])
  })
})

describe('a socket belongs to at most one room (review F3)', () => {
  test('attachPeer detaches the socket from its previous room', () => {
    const { registry } = harness()
    const a = ws(1)
    const first = registry.joinOrCreate('mauve-peacock-candle').room!
    registry.attachPeer(a, first)
    expect(first.peers.has(a)).toBe(true)
    expect(a.data.roomCode).toBe('mauve-peacock-candle')

    const second = registry.joinOrCreate('rose-thistle-moss').room!
    registry.attachPeer(a, second)

    // Not in the old room's peer set any more: its later expiry must not
    // send this (now live-elsewhere) client a terminal room_expired.
    expect(first.peers.has(a)).toBe(false)
    expect(second.peers.has(a)).toBe(true)
    expect(a.data.roomCode).toBe('rose-thistle-moss')
  })

  test('leaving a room that is now empty deletes it (nobody is there)', () => {
    const { registry } = harness()
    const a = ws(1)
    const first = registry.joinOrCreate('mauve-peacock-candle').room!
    registry.attachPeer(a, first)
    const second = registry.joinOrCreate('rose-thistle-moss').room!
    registry.attachPeer(a, second)
    expect(registry.rooms.size).toBe(1)
    expect(registry.get('mauve-peacock-candle')).toBeUndefined()
  })

  test('attachPeer to the SAME room is a no-op re-add', () => {
    const { registry } = harness()
    const a = ws(1)
    const room = registry.joinOrCreate('mauve-peacock-candle').room!
    registry.attachPeer(a, room)
    registry.attachPeer(a, room)
    expect(room.peers.size).toBe(1)
    expect(registry.rooms.size).toBe(1)
  })
})

describe('rev is monotone per CODE, not per room instance (review F4)', () => {
  test('the floor survives the empty-room delete and is handed back', () => {
    const { registry } = harness()
    const a = ws(1)
    const room = registry.joinOrCreate('mauve-peacock-candle').room!
    registry.attachPeer(a, room)
    registry.noteState(room, 5, { plan: [] })
    expect(registry.floorRev('mauve-peacock-candle')).toBe(5)

    // Everyone leaves → the room (and its state) is gone…
    registry.removePeer(a, room)
    expect(registry.rooms.size).toBe(0)
    // …but the household's revision history is not: a re-created room
    // continues at 5 instead of restarting at 0, so nobody can mistake
    // a fresh snapshot for "newer than what we already had".
    const again = registry.joinOrCreate('mauve-peacock-candle')
    expect(again.created).toBe(true)
    expect(registry.floorRev('mauve-peacock-candle')).toBe(5)
  })

  test('the floor only ever moves up', () => {
    const { registry } = harness()
    const room = registry.joinOrCreate('mauve-peacock-candle').room!
    registry.noteState(room, 7, {})
    registry.noteState(room, 3, {}) // a lagging peer must not rewind us
    expect(registry.floorRev('mauve-peacock-candle')).toBe(7)
    registry.noteState(room, 8, {})
    expect(registry.floorRev('mauve-peacock-candle')).toBe(8)
  })

  test('an unknown code has no floor, and a stale one is pruned', () => {
    const { registry, clock } = harness({ idleTtlMs: 60_000 })
    expect(registry.floorRev('never-seen')).toBe(0)
    const room = registry.joinOrCreate('mauve-peacock-candle').room!
    registry.noteState(room, 5, {})
    clock.t += 59_000
    expect(registry.floorRev('mauve-peacock-candle')).toBe(5)
    clock.t += 2_000 // older than the idle TTL → the history is meaningless
    expect(registry.floorRev('mauve-peacock-candle')).toBe(0)
  })

  test('floors are per code, never shared between rooms', () => {
    const { registry } = harness()
    const one = registry.joinOrCreate('mauve-peacock-candle').room!
    const two = registry.joinOrCreate('rose-thistle-moss').room!
    registry.noteState(one, 9, {})
    registry.noteState(two, 2, {})
    expect(registry.floorRev('mauve-peacock-candle')).toBe(9)
    expect(registry.floorRev('rose-thistle-moss')).toBe(2)
  })

  test('noteState preserves stored history when a sender omits the key (ADR-0032)', () => {
    // An opted-out sender's keyless snapshot must not erase the household
    // cooking log: room.state is what a LATER JOINER adopts, and a
    // wholesale replace would make the room answer `joined` with no
    // history at all — the sharing peers' cooks stranded on their devices.
    const { registry } = harness()
    const room = registry.joinOrCreate('mauve-peacock-candle').room!
    const history = [{ variantId: 5, cookedAt: 50, id: 'peer-1' }]
    registry.noteState(room, 5, { plan: [], cookedHistory: history })
    expect(room.state.cookedHistory).toEqual(history)

    // An opted-out push (no key) keeps the stored history.
    registry.noteState(room, 6, { plan: [], checked: {} })
    expect(room.state.cookedHistory).toEqual(history)

    // A sharing push (key PRESENT, even empty) replaces wholesale — the
    // sender is authoritative when it speaks about history.
    registry.noteState(room, 7, { plan: [], cookedHistory: [] })
    expect(room.state.cookedHistory).toEqual([])

    // No stored history yet + keyless push → stays keyless (nothing to
    // preserve, no fabricated empty list a client would read as a wipe).
    const other = registry.joinOrCreate('rose-thistle-moss').room!
    registry.noteState(other, 1, { plan: [] })
    expect('cookedHistory' in other.state).toBe(false)
  })

  test('noteState preserves a stored plan identity ONLY when the key is absent (ADR-0034)', () => {
    // `planIdentity` is EXPLICITLY nullable: `null` is a real answer
    // ("the plan is empty") and replaces wholesale, while an ABSENT key is
    // an older peer that has nothing to say. Preserving the absent case but
    // honoring the null is what keeps one household's batch from being
    // re-identified — and split into two History groups — by whichever
    // phone pushed last.
    const { registry } = harness()
    const room = registry.joinOrCreate('mauve-peacock-candle').room!
    const identity = { planId: 'plan-household', planCreatedAt: 1000 }

    registry.noteState(room, 1, { plan: [], planIdentity: identity })
    expect(room.state.planIdentity).toEqual(identity)

    // An older peer's keyless push keeps the household's identity.
    registry.noteState(room, 2, { plan: [] })
    expect(room.state.planIdentity).toEqual(identity)

    // `null` is an ANSWER: that phone's plan ended, so the room adopts it
    // and a later joiner does not keep an identity for a plan that is gone.
    registry.noteState(room, 3, { plan: [], planIdentity: null })
    expect(room.state.planIdentity).toBeNull()

    // Nothing stored yet + keyless push → nothing fabricated.
    const other = registry.joinOrCreate('rose-thistle-moss').room!
    registry.noteState(other, 1, { plan: [] })
    expect('planIdentity' in other.state).toBe(false)
  })
})

describe('keepalive keeps a room alive (review F1)', () => {
  test('touchRoom (what keepalive does) refreshes BOTH clocks', () => {
    // The idle backstop is SHORTER than the inactivity window here, so
    // the room can only survive if the keepalive path refreshes both.
    const { registry, timers, expired } = harness({
      inactivityTtlMs: 60_000,
      idleTtlMs: 2_000,
    })
    const room = registry.joinOrCreate('mauve-peacock-candle').room!
    room.peers.add(ws(1))

    for (let i = 0; i < 8; i++) {
      timers.advance(300) // one keepalive tick
      registry.touchRoom(room)
    }
    expect(registry.get('mauve-peacock-candle')).toBe(room)
    expect(expired).toEqual([])
  })

  test('a keepalive alone (no state traffic) keeps a room past the idle backstop', () => {
    const { registry, timers, expired } = harness({
      inactivityTtlMs: 60_000,
      idleTtlMs: 2_000,
    })
    const room = registry.joinOrCreate('mauve-peacock-candle').room!
    room.peers.add(ws(1))

    // One keepalive before the 2s backstop fires pushes it out; without it
    // the room is gone at 2s (the control assertion below).
    timers.advance(1_500)
    registry.touchRoom(room) // keepalive
    timers.advance(1_500)
    expect(registry.get('mauve-peacock-candle')).toBe(room)
    expect(expired).toEqual([])

    // Control: once the keepalives stop, the backstop does close it.
    timers.advance(2_000)
    expect(registry.rooms.size).toBe(0)
    expect(expired).toEqual([{ code: 'mauve-peacock-candle', reason: 'idle' }])
  })
})
