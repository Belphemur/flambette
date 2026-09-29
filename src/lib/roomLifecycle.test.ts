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
  const registry = createRoomRegistry({
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    mintCode: () => 'AAA111',
    onExpire: (room: { code: string }, reason: string) => expired.push({ code: room.code, reason }),
    ...overrides,
  })
  return { registry, timers, expired }
}

const ws = (peerId: number) => ({ data: { peerId, roomCode: undefined as string | undefined } })

describe('relay room codes', () => {
  test('defaults: 1h inactivity, 12h idle backstop', () => {
    expect(INACTIVITY_TTL_MS).toBe(60 * 60 * 1000)
    expect(IDLE_TTL_MS).toBe(12 * 60 * 60 * 1000)
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
  test('a room with no keepalive is closed after the 1h inactivity window', () => {
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
    // Still armed, one full hour after the LAST keepalive.
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

  test('the 12h idle backstop fires with reason=idle', () => {
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
