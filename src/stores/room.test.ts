import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createPinia, setActivePinia } from 'pinia'
import { usePlanStore } from './plan'
import { useUiStore } from './ui'
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

  test('a FRESH tab applies the state of the room it joins and does NOT echo it (F4 regression)', async () => {
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
    // Adopting the snapshot leaves our state byte-identical to the room's,
    // so the joiner must NOT re-publish it at a higher rev: an echo can
    // only ever out-rank a peer's newer, still-in-flight push (ADR-0028).
    expect(socket.frames('state')).toHaveLength(0)
  })

  test('a joiner whose snapshot was REJECTED by the rev floor pushes its own state (F4)', async () => {
    const plan = usePlanStore()
    const room = useRoomStore()
    room.join('amber-falcon-lantern')
    await sleep(5)
    const socket = sockets[sockets.length - 1]
    // This session already proved rev 9 for this code; the room (deleted
    // and re-created meanwhile) reports a lower rev, so the snapshot is
    // rejected — and then our state is the newest thing we can prove.
    sessionStorage.setItem(ROOM_REV_KEY, JSON.stringify({ code: 'amber-falcon-lantern', rev: 9 }))
    plan.replacePlan([{ variantId: 7, servings: 6 }], [])
    socket.receive({
      type: 'joined',
      code: 'amber-falcon-lantern',
      rev: 2,
      state: { plan: [], customItems: [], checked: {} },
    })
    expect(plan.plan).toHaveLength(1)
    const pushed = socket.frames('state').at(-1)!
    expect(pushed.rev as number).toBeGreaterThan(9)
    expect((pushed.state as { plan: unknown[] }).plan).toHaveLength(1)
  })

  test('joining an EMPTY room still seeds it with our state', async () => {
    const plan = usePlanStore()
    const room = useRoomStore()
    room.join('rose-thistle-moss')
    await sleep(5)
    const socket = sockets[sockets.length - 1]
    socket.receive({ type: 'joined', code: 'rose-thistle-moss', rev: 0, state: null })
    expect(plan.plan).toHaveLength(0)
    expect(socket.frames('state')).toHaveLength(1)
  })
})

describe('room store — quick filters are household state (ADR-0028)', () => {
  test('a payload WITH filters is applied, unknown members are repaired', async () => {
    const { socket } = await startRoom()
    socket.receive({
      type: 'state',
      rev: 99,
      state: {
        plan: [],
        customItems: [],
        checked: {},
        filters: { diets: ['vegan', 'keto'], protein: 'fish', sortBy: 'time', favOnly: true },
      },
    })
    const ui = useUiStore()
    // The unknown diet id is dropped, the missing members take defaults.
    expect(ui.quickFilters.diets).toEqual(['vegan'])
    expect(ui.quickFilters.protein).toBe('fish')
    expect(ui.quickFilters.sortBy).toBe('time')
    // …but `favOnly` is PERSONAL: a peer's switch must not be adopted
    // (it would blank a device whose favourites differ).
    expect(ui.quickFilters.favOnly).toBe(false)
    expect(ui.quickFilters.proOnly).toBe(false)
  })

  test('favOnly stays local even when it is already on here', async () => {
    const ui = useUiStore()
    ui.quickFilters = { ...ui.quickFilters, favOnly: true }
    const { socket } = await startRoom()
    // The wire never carries it…
    const seeded = socket.frames('state')[0]
    expect('favOnly' in ((seeded.state as { filters?: object }).filters ?? {})).toBe(false)
    // …and an inbound payload cannot switch it off.
    socket.receive({
      type: 'state',
      rev: 99,
      state: { plan: [], customItems: [], checked: {}, filters: { favOnly: false } },
    })
    expect(ui.quickFilters.favOnly).toBe(true)
  })

  test('a payload WITHOUT filters (older peer) leaves the local selection alone', async () => {
    const ui = useUiStore()
    ui.quickFilters = { ...ui.quickFilters, diets: ['vegetarian'], maxTime: 45 }
    const { socket } = await startRoom()
    socket.receive({
      type: 'state',
      rev: 99,
      state: { plan: [], customItems: [], checked: {} },
    })
    expect(ui.quickFilters.diets).toEqual(['vegetarian'])
    expect(ui.quickFilters.maxTime).toBe(45)
  })

  test('a queued local edit is not clobbered by a snapshot older than its push', async () => {
    const ui = useUiStore()
    const plan = usePlanStore()
    const { socket } = await startRoom()
    // Local edit: the debounce (300ms) is still open when the peer's
    // older snapshot lands. Without the guard, the push built at fire time
    // re-broadcasts the peer's value and the household converges on the
    // WRONG answer even though this edit is the newer fact.
    ui.quickFilters = { ...ui.quickFilters, diets: ['vegan'] }
    socket.receive({
      type: 'state',
      rev: 50,
      state: { plan: [], customItems: [], checked: {}, filters: { diets: ['no-pork'] } },
    })
    expect(ui.quickFilters.diets).toEqual(['vegan'])

    await sleep(500)
    // The push carries OUR state at a higher rev…
    const pushed = socket.frames('state').at(-1)!
    expect((pushed.state as { filters: { diets: string[] } }).filters.diets).toEqual(['vegan'])
    expect(pushed.rev as number).toBeGreaterThan(50)
    // …and a later peer push still applies normally.
    socket.receive({
      type: 'state',
      rev: (pushed.rev as number) + 1,
      state: { plan: [], customItems: [], checked: {}, filters: { diets: ['no-meat'] } },
    })
    expect(ui.quickFilters.diets).toEqual(['no-meat'])
    void plan
  })

  test('an edit made while the socket is not live is published, not silently dropped', async () => {
    const ui = useUiStore()
    const room = useRoomStore()
    // The join is in flight (connecting, code set — the ~1s a room takes
    // to come up): a filter tap in that window has nowhere to go…
    room.join('amber-falcon-lantern')
    ui.quickFilters = { ...ui.quickFilters, diets: ['vegan'] }
    await sleep(5)
    const socket = sockets[sockets.length - 1]
    // …and the join response carries the room's OLDER state. Silently
    // adopting it would swallow the edit with nothing to republish it.
    socket.receive({
      type: 'joined',
      code: 'amber-falcon-lantern',
      rev: 4,
      state: { plan: [], customItems: [], checked: {}, filters: { diets: [] } },
    })
    expect(ui.quickFilters.diets).toEqual(['vegan'])
    const pushed = socket.frames('state').at(-1)!
    expect((pushed.state as { filters: { diets: string[] } }).filters.diets).toEqual(['vegan'])
    expect(pushed.rev as number).toBeGreaterThan(4)
  })

  test('an edit made with NO room at all never claims a pending publish', async () => {
    // The flag exists to protect a join in flight. With no room, there is
    // no join to protect: carrying the flag would make a join much later
    // skip the household's snapshot and push a stale local plan over it
    // (qodo 2).
    const ui = useUiStore()
    const plan = usePlanStore()
    plan.replacePlan([{ variantId: 7, servings: 6 }], [])
    ui.quickFilters = { ...ui.quickFilters, diets: ['vegan'] }
    const room = useRoomStore()
    room.join('amber-falcon-lantern')
    await sleep(5)
    const socket = sockets[sockets.length - 1]
    // The household has its own plan: it must win.
    socket.receive({
      type: 'joined',
      code: 'amber-falcon-lantern',
      rev: 4,
      state: { plan: [{ variantId: 42, servings: 6 }], customItems: [], checked: {} },
    })
    expect(plan.plan[0].variantId).toBe(42)
    // The household payload carried no `filters` at all, so the local
    // selection is left alone (absence = "don't touch", ADR-0028).
    expect(ui.quickFilters.diets).toEqual(['vegan'])
    // A payload that DOES carry filters still wins.
    socket.receive({
      type: 'state',
      rev: 6,
      state: { plan: [], customItems: [], checked: {}, filters: { diets: [] } },
    })
    expect(ui.quickFilters.diets).toEqual([])
  })

  test('a socket dropped inside the debounce keeps the edit for the next join', async () => {
    const ui = useUiStore()
    const { room, socket } = await startRoom()
    ui.quickFilters = { ...ui.quickFilters, diets: ['vegan'] }
    // The socket dies before the 300ms push fires.
    socket.receive({ type: 'error', code: 'rate_limited' })
    expect(socket.frames('state').at(-1)!.state).toBeDefined()
    await sleep(BACKOFF_MS + 400) // reconnected
    expect(sockets.length).toBeGreaterThan(1)
    const rejoined = sockets[sockets.length - 1]
    // The relay answers the re-join with an EMPTY room (no state).
    rejoined.receive({ type: 'joined', code: 'mauve-peacock-candle', rev: 1 })
    expect(ui.quickFilters.diets).toEqual(['vegan'])
    // The re-join republished our edit rather than dropping it.
    const pushed = rejoined.frames('state').at(-1)!
    expect((pushed.state as { filters?: { diets?: string[] } }).filters?.diets).toEqual(['vegan'])
  })

  test('leaving a room clears the undelivered-edit state', async () => {
    const ui = useUiStore()
    const room = useRoomStore()
    ui.quickFilters = { ...ui.quickFilters, diets: ['vegan'] }
    room.join('amber-falcon-lantern')
    await sleep(5)
    sockets[sockets.length - 1].receive({ type: 'created', code: 'amber-falcon-lantern', rev: 0 })
    ui.quickFilters = { ...ui.quickFilters, diets: ['no-meat'] }
    room.leave()
    // A later join into a DIFFERENT room must adopt, not republish.
    room.join('rose-thistle-moss')
    await sleep(5)
    const socket = sockets[sockets.length - 1]
    socket.receive({
      type: 'joined',
      code: 'rose-thistle-moss',
      rev: 9,
      state: { plan: [{ variantId: 42, servings: 6 }], customItems: [], checked: {}, filters: { diets: ['vegan'] } },
    })
    expect(ui.quickFilters.diets).toEqual(['vegan'])
    expect(usePlanStore().plan[0].variantId).toBe(42)
  })

  test('the filters travel in the snapshot, and a change is pushed', async () => {
    const ui = useUiStore()
    const { socket } = await startRoom()
    const seeded = socket.frames('state')[0]
    // Everything except the personal `favOnly` half (ADR-0028).
    expect((seeded.state as { filters?: unknown }).filters).toEqual({
      diets: ui.quickFilters.diets,
      protein: ui.quickFilters.protein,
      maxTime: ui.quickFilters.maxTime,
      sortBy: ui.quickFilters.sortBy,
      proOnly: ui.quickFilters.proOnly,
    })

    ui.quickFilters = { ...ui.quickFilters, sortBy: 'latest' }
    await sleep(500) // PUSH_DEBOUNCE_MS
    const pushed = socket.frames('state').at(-1)!
    expect((pushed.state as { filters: { sortBy: string } }).filters.sortBy).toBe('latest')
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
