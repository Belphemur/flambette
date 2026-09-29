import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createPinia, setActivePinia } from 'pinia'
import { usePlanStore } from './plan'
import { useRoomStore, type RoomStatus } from './room'

/**
 * Room store behaviour that the wire-level e2e cannot reach: what the
 * client does with a relay `error` frame, and how it numbers its
 * revisions. Driven through a fake WebSocket — no network, no browser.
 *
 * Review findings covered here: F4 (rev floor), F5 (orphaned reconnect
 * timer), F6 (a refused frame must not recycle the socket / send leave).
 */

const ROOM_CODE_KEY = 'mealime-planner:v1:room-code'
const ROOM_REV_KEY = 'mealime-planner:v1:room-rev'

/** Every socket the store ever constructed, in order. */
let sockets: FakeSocket[] = []

class FakeSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 3
  readyState = 1
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  readonly sent: Record<string, unknown>[] = []
  closed = false

  constructor(readonly url: string) {
    sockets.push(this)
    // The relay accepts the upgrade asynchronously; mirror that.
    setTimeout(() => this.onopen?.(), 0)
  }

  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }

  close() {
    this.closed = true
    this.readyState = 3
    this.onclose?.()
  }

  /** Deliver a frame as if the relay had sent it. */
  receive(msg: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }

  frames(type: string): Record<string, unknown>[] {
    return this.sent.filter((f) => f.type === type)
  }

  get last() {
    return this.sent[this.sent.length - 1]
  }
}

function memoryStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** The store's reconnect backoff starts at 1s. */
const BACKOFF_MS = 1000

let store: ReturnType<typeof useRoomStore>

/** Start a session: fresh pinia, fake globals, a created room. */
async function startRoom(joinCode = 'mauve-peacock-candle') {
  const room = useRoomStore()
  room.join(joinCode)
  await sleep(5) // let the fake socket open and send `join`
  const socket = sockets[sockets.length - 1]
  socket.receive({ type: 'created', code: joinCode, rev: 0 })
  return { room, socket }
}

beforeEach(() => {
  sockets = []
  ;(globalThis as Record<string, unknown>).WebSocket = FakeSocket
  ;(globalThis as Record<string, unknown>).sessionStorage = memoryStorage()
  ;(globalThis as Record<string, unknown>).localStorage = memoryStorage()
  ;(globalThis as Record<string, unknown>).location = { protocol: 'http:', host: 'localhost:4173' }
  setActivePinia(createPinia())
  store = useRoomStore()
})

afterEach(() => {
  store.leave()
})

describe('room store — a refused frame does not recycle the socket (F6)', () => {
  test('bad_state leaves a live socket live, with no leave and no reconnect', async () => {
    const { room, socket } = await startRoom()
    expect(room.status).toBe<RoomStatus>('live')

    // Our own snapshot was refused by the relay; the room is fine.
    socket.receive({ type: 'error', code: 'bad_state' })

    expect(room.status).toBe<RoomStatus>('live')
    expect(socket.closed).toBe(false)
    expect(socket.frames('leave')).toHaveLength(0)
    await sleep(BACKOFF_MS + 200)
    // No second socket was ever constructed.
    expect(sockets).toHaveLength(1)
  })

  test('bad_json / unknown_type are equally inert', async () => {
    for (const code of ['bad_json', 'unknown_type']) {
      sockets = []
      const { room, socket } = await startRoom()
      socket.receive({ type: 'error', code })
      expect(room.status).toBe<RoomStatus>('live')
      expect(socket.closed).toBe(false)
      store.leave()
    }
    expect(sockets.every((s) => s.frames('leave').length === 1)).toBe(true) // only the explicit leave()
  })

  test('a recycled socket never announces a leave (F6)', async () => {
    const { room, socket } = await startRoom()
    // rate_limited IS retryable, so a new socket is opened…
    socket.receive({ type: 'error', code: 'rate_limited' })
    expect(room.status).toBe<RoomStatus>('connecting')
    await sleep(BACKOFF_MS + 300)
    expect(sockets.length).toBeGreaterThan(1)
    // …but the socket it recycled did not tell the relay we left the room.
    expect(socket.frames('leave')).toHaveLength(0)
  })
})

describe('room store — reconnect timers cannot outlive a terminal error (F5)', () => {
  test('a scheduled reconnect is cancelled by the terminal error that follows', async () => {
    const { room, socket } = await startRoom()
    // Schedule a reconnect, then immediately hit the terminal case.
    socket.receive({ type: 'error', code: 'rate_limited' })
    expect(room.status).toBe<RoomStatus>('connecting')
    socket.receive({ type: 'error', code: 'room_expired' })
    expect(room.status).toBe<RoomStatus>('error')

    // Without the fix the orphaned timer fires here and connects() clears
    // `roomGone` — a new socket would appear and the room would be
    // join-or-created back into existence.
    await sleep(BACKOFF_MS + 300)
    expect(sockets).toHaveLength(1)
    expect(room.status).toBe<RoomStatus>('error')
  })

  test('repeated retryable errors keep exactly one pending reconnect', async () => {
    const { room, socket } = await startRoom()
    // Backoff grows with each attempt (1s, then 2s): without the
    // clear-before-schedule fix BOTH timers survive and the second fires
    // long after the first already opened a replacement socket.
    socket.receive({ type: 'error', code: 'rate_limited' })
    socket.receive({ type: 'error', code: 'rate_limited' })
    await sleep(BACKOFF_MS * 2 + 500)
    // One timer, not two: exactly one replacement socket.
    expect(sockets).toHaveLength(2)
    expect(room.status).toBe<RoomStatus>('connecting')
  })
})

describe('room store — revisions never restart (F4)', () => {
  test('created carries the per-code floor, so the seed lands above it', async () => {
    const room = useRoomStore()
    room.join('mauve-peacock-candle')
    await sleep(5)
    const socket = sockets[sockets.length - 1]
    // The relay hands back the highest rev this code ever reached (the
    // room was deleted and re-created after everyone left).
    socket.receive({ type: 'created', code: 'mauve-peacock-candle', rev: 41 })

    const seeded = socket.frames('state')[0]
    expect(seeded).toBeDefined()
    expect(seeded.rev).toBe(42)
  })

  test('a stale snapshot from a re-created room never overwrites local state', async () => {
    const plan = usePlanStore()
    const { room, socket } = await startRoom()
    plan.replacePlan([{ variantId: 7, servings: 6 }], [])
    // A returning member reloads: the room was deleted meanwhile and a
    // fresh one reports a LOW rev, but our session remembers rev 9.
    sessionStorage.setItem(ROOM_REV_KEY, JSON.stringify({ code: 'mauve-peacock-candle', rev: 9 }))
    socket.receive({
      type: 'joined',
      code: 'mauve-peacock-candle',
      rev: 2,
      state: { plan: [], customItems: [], checked: {} },
    })

    // The low-rev snapshot is rejected — the local plan survives…
    expect(plan.plan).toHaveLength(1)
    expect(plan.plan[0].variantId).toBe(7)
    // …and what we push is newer than anything this tab ever saw.
    const pushed = socket.frames('state').at(-1)!
    expect(pushed.rev as number).toBeGreaterThan(9)
    expect(room.status).toBe<RoomStatus>('live')
  })

  test('the floor is remembered per code, never across codes', async () => {
    await startRoom('mauve-peacock-candle')
    sessionStorage.setItem(ROOM_REV_KEY, JSON.stringify({ code: 'mauve-peacock-candle', rev: 9 }))
    const other = useRoomStore()
    other.join('rose-thistle-moss')
    await sleep(5)
    const socket = sockets[sockets.length - 1]
    socket.receive({ type: 'created', code: 'rose-thistle-moss', rev: 0 })
    expect(socket.frames('state')[0].rev).toBe(1)
  })

  test('a FRESH tab still applies the state of the room it joins (F4 regression)', async () => {
    // The floor must never become a reason to IGNORE the room's current
    // state: a second device that has never been in this room has no
    // local state to protect, and its own localRev starts at 0.
    const plan = usePlanStore()
    const room = useRoomStore()
    room.join('amber-falcon-lantern')
    await sleep(5)
    const socket = sockets[sockets.length - 1]
    socket.receive({
      type: 'joined',
      code: 'amber-falcon-lantern',
      rev: 3,
      state: { plan: [{ variantId: 42, servings: 6 }], customItems: [], checked: {} },
    })
    expect(plan.plan).toHaveLength(1)
    expect(plan.plan[0].variantId).toBe(42)
    // …and what it then pushes is newer than the snapshot it took.
    expect(socket.frames('state').at(-1)!.rev as number).toBeGreaterThan(3)
  })
})

describe('room store — terminal errors stop the loop', () => {
  test('room_expired clears the stored code but keeps it for the UI', async () => {
    const { room, socket } = await startRoom()
    expect(sessionStorage.getItem(ROOM_CODE_KEY)).toBe('mauve-peacock-candle')
    socket.receive({ type: 'error', code: 'room_expired', reason: 'inactive' })

    expect(room.status).toBe<RoomStatus>('error')
    expect(room.error).toContain('expired')
    // The code stays readable (header chip, household toast)…
    expect(room.code).toBe('mauve-peacock-candle')
    // …but the session no longer resumes a dead room.
    expect(sessionStorage.getItem(ROOM_CODE_KEY)).toBeNull()
    await sleep(BACKOFF_MS + 200)
    expect(sockets).toHaveLength(1)
  })
})
