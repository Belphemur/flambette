import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { generateRoomCode, normalizeRoomCode } from '../lib/roomWords'
import { describeRelayError } from '../lib/relayErrors'
import { useCustomIngredientsStore, type CustomIngredient } from './customIngredients'
import { usePlanStore, type CookedEntry } from './plan'
import { useGroceryStore } from './grocery'
import { useUiStore } from './ui'

export type RoomStatus = 'idle' | 'connecting' | 'live' | 'error'

/** Shape both peers share via the relay. Client-owned, whole-state LWW.
 *  Unknown optional fields (customs, cookedHistory) are ignored by older
 *  peers — the payload evolves additively (ADR-0012 / ADR-0011 addendum). */
interface SharedState {
  plan: { variantId: number; servings: number }[]
  customItems: string[]
  checked: Record<string, boolean>
  /** variantId -> nameKey-normalized ingredient keys cleared per meal. */
  cleared?: Record<number, string[]>
  /** Remembered custom-ingredient names — HOUSEHOLD state (ADR-0012:
   *  device-local → household, 2026 policy change). */
  customs?: CustomIngredient[]
  /** Personal cooked history — included ONLY when the sender opted in via
   *  the shareCookedHistory setting (ADR-0011 addendum); otherwise a
   *  personal slice that must never cross the wire. */
  cookedHistory?: CookedEntry[]
}

const PUSH_DEBOUNCE_MS = 300
const RECONNECT_MIN_MS = 1000
const RECONNECT_MAX_MS = 30_000
/**
 * Application-level keepalive (ADR-0026). The relay closes a room after
 * 1h with no keepalive and no state activity, and tells its peers
 * `room_expired`. 60s is a wide margin on a 1h window while costing one
 * tiny frame a minute; it is NOT throttled server-side, so a long-lived
 * room can never spend its create/join budget on liveness.
 */
const KEEPALIVE_MS = 60_000
/** Re-rolls of a taken three-word code before falling back to a relay-minted one. */
const CODE_REROLL_LIMIT = 3

/** Session-scoped storage of the room code: survives reloads, not tab closes. */
const ROOM_CODE_KEY = 'mealime-planner:v1:room-code'
/**
 * Session-scoped high-water mark of the household's `rev` for the code we
 * were last in (review F4). `localRev` is in-memory and restarts at 0 on
 * every page load, while the relay keeps a per-code floor that survives an
 * empty-room delete — without this, a reloaded client would seed the
 * re-created room at rev 1 and its edits would be ignored by peers already
 * past that point. Keyed by code so two rooms never cross-contaminate.
 */
const ROOM_REV_KEY = 'mealime-planner:v1:room-rev'

interface StoredRev {
  code: string
  rev: number
}

function readRevFloor(code: string | null): number {
  if (!code) return 0
  try {
    const raw = sessionStorage.getItem(ROOM_REV_KEY)
    if (!raw) return 0
    const parsed = JSON.parse(raw) as StoredRev
    return parsed.code === code && Number.isFinite(parsed.rev) ? parsed.rev : 0
  } catch {
    return 0
  }
}

function writeRevFloor(code: string | null, rev: number) {
  if (!code) return
  try {
    sessionStorage.setItem(ROOM_REV_KEY, JSON.stringify({ code, rev }))
  } catch {
    /* session storage full/unavailable: the floor is an optimization */
  }
}

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}${import.meta.env.BASE_URL}ws`
}

export const useRoomStore = defineStore('room', () => {
  const plan = usePlanStore()
  const grocery = useGroceryStore()
  const customIngredients = useCustomIngredientsStore()
  const ui = useUiStore()

  const status = ref<RoomStatus>('idle')
  const code = ref<string | null>(null)
  const error = ref<string | null>(null)

  let ws: WebSocket | null = null
  let localRev = 0
  let maxSeenRev = 0
  let reconnectAttempts = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let pushTimer: ReturnType<typeof setTimeout> | null = null
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null
  /** True while we're writing a remote snapshot into the local stores. */
  let applyingRemote = false
  /** The three-word code we asked the relay to create with (ADR-0021). */
  let wantedCode: string | null = null
  let codeRerolls = 0
  /**
   * Set when the relay told us the room is gone for good (`room_expired`,
   * `not_found`, or an unknown error). The code is KEPT — the header chip
   * and the household toast both read it (App.vue) — but every reconnect
   * path is disabled: re-joining would join-or-create a brand-new EMPTY
   * room and look like silent household data loss. A deliberate
   * create/join/resume clears it.
   */
  let roomGone = false

  const inRoom = computed(() => code.value !== null)

  /** Live room link for this client's room (null when not in a room). */
  function roomLink(): string | null {
    return code.value ? roomLinkFor(code.value) : null
  }

  /**
   * The join URL for a specific code — usable before this device has
   * actually joined (the household setting may name a room the relay has
   * not re-created yet), which is what "Share room" copies.
   */
  function roomLinkFor(target: string): string {
    return `${location.origin}${import.meta.env.BASE_URL}plan?room=${target}`
  }

  /* ---------- state conversion ---------- */

  function snapshot(): SharedState {
    const checked: Record<string, boolean> = {}
    for (const [key, value] of Object.entries(grocery.map)) {
      if (value) checked[key] = true
    }
    const state: SharedState = {
      plan: plan.plan.map((e) => ({ variantId: e.variantId, servings: e.servings })),
      customItems: [...plan.customItems],
      checked,
      cleared: { ...plan.clearedIngredients },
      // Household state (ADR-0012): remembered custom-ingredient names.
      customs: customIngredients.list.map((c) => ({ ...c })),
    }
    // Personal history only crosses the wire when the sender opted in.
    if (ui.shareCookedHistory) {
      state.cookedHistory = plan.cookedHistory.map((h) => ({ ...h }))
    }
    return state
  }

  function applyRemote(state: SharedState) {
    applyingRemote = true
    try {
      plan.replacePlan(state.plan ?? [], state.customItems ?? [])
      const checked: Record<string, boolean> = {}
      for (const [key, value] of Object.entries(state.checked ?? {})) {
        if (value) checked[key] = true
      }
      grocery.map = checked
      plan.setClearedIngredients(state.cleared ?? {})
      // Household custom-ingredient memory (ADR-0012); absent on old
      // payloads → treated as "nothing shared yet", NOT as "wipe local".
      if (state.customs) customIngredients.replaceAll(state.customs)
      // Cooked history arrives only from opted-in senders (ADR-0011
      // addendum). Wipe-to-empty is intentional when a sharer with an
      // empty history pushes: whole-state LWW.
      if (state.cookedHistory) plan.replaceCookedHistory(state.cookedHistory)
    } finally {
      applyingRemote = false
    }
  }

  /* ---------- push (debounced) ---------- */

  function schedulePush() {
    if (applyingRemote || status.value !== 'live') return
    if (pushTimer) clearTimeout(pushTimer)
    pushTimer = setTimeout(() => {
      pushTimer = null
      if (status.value !== 'live' || !ws || ws.readyState !== WebSocket.OPEN) return
      localRev = Math.max(localRev, maxSeenRev) + 1
      sendState()
    }, PUSH_DEBOUNCE_MS)
  }

  /** One place that writes a snapshot, so the rev floor (F4) is never missed. */
  function sendState() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    writeRevFloor(code.value, localRev)
    ws.send(JSON.stringify({ type: 'state', rev: localRev, state: snapshot() }))
  }

  /**
   * Raise `maxSeenRev` to the highest revision anyone can prove for this
   * code: the relay's reply (the per-code floor, which outlives an
   * empty-room delete) and our own session high-water mark. Everything we
   * PUSH from here on is strictly newer than both, so a room that was
   * deleted and re-created cannot present a stale snapshot as a newer one
   * (review F4).
   *
   * `localRev` is deliberately NOT raised here: it is "the revision of
   * the state I am holding", and on a fresh page load that is 0 — which
   * is exactly what lets an incoming room snapshot still be recognised as
   * newer than local. What a snapshot must clear instead is the session
   * floor (see the `joined` branch).
   */
  function absorbRevFloor(relayRev: unknown) {
    const fromRelay = typeof relayRev === 'number' && Number.isFinite(relayRev) ? relayRev : 0
    maxSeenRev = Math.max(maxSeenRev, fromRelay, readRevFloor(code.value))
  }

  // Any local change to plan or checked groceries is pushed to the room.
  // flush: 'sync' so remote snapshots applied inside applyRemote() (guarded
  // by `applyingRemote`) never echo back as new pushes.
  watch(
    () =>
      [
        plan.plan,
        plan.customItems,
        grocery.map,
        plan.clearedIngredients,
        customIngredients.list,
        plan.cookedHistory, // only pushed when ui.shareCookedHistory — snapshot() gates it
        ui.shareCookedHistory, // flipping ON must trigger a retroactive push
      ] as const,
    () => schedulePush(),
    { deep: true, flush: 'sync' },
  )

  /* ---------- keepalive (ADR-0026) ---------- */

  /** One interval per live socket; stopped on every end path in cleanupSocket. */
  function startKeepalive() {
    if (keepaliveTimer) clearInterval(keepaliveTimer)
    keepaliveTimer = setInterval(() => {
      if (status.value !== 'live' || !ws || ws.readyState !== WebSocket.OPEN) return
      try {
        ws.send(JSON.stringify({ type: 'keepalive' }))
      } catch {
        // Socket is on its way out; onclose drives the reconnect.
        stopKeepalive()
      }
    }, KEEPALIVE_MS)
  }

  function stopKeepalive() {
    if (!keepaliveTimer) return
    clearInterval(keepaliveTimer)
    keepaliveTimer = null
  }

  /* ---------- connection ---------- */

  function handleMessage(msg: Record<string, unknown>) {
    switch (msg.type) {
      case 'created': {
        code.value = typeof msg.code === 'string' ? msg.code : null
        if (code.value) sessionStorage.setItem(ROOM_CODE_KEY, code.value)
        status.value = 'live'
        reconnectAttempts = 0
        startKeepalive()
        // Seed the room with our current state. Also reached from the
        // JOIN path: a join for a code the relay does not know yet
        // answers `created` (join-or-create, ADR-0026), so the first
        // client to arrive establishes the room and seeds it itself.
        // Seed ABOVE the per-code rev floor (review F4), never at rev 1.
        absorbRevFloor(msg.rev)
        localRev = maxSeenRev + 1
        sendState()
        break
      }
      case 'joined': {
        status.value = 'live'
        reconnectAttempts = 0
        startKeepalive()
        absorbRevFloor(msg.rev)
        if (msg.state != null) {
          const rev = typeof msg.rev === 'number' ? msg.rev : localRev + 1
          // Newer than what we hold AND at least as new as anything this
          // session already proved for this code (review F4): a room
          // re-created after a restart must not talk a member that has
          // been at revision 9 back down to an empty plan at 2.
          if (rev > localRev && rev >= readRevFloor(code.value)) {
            maxSeenRev = localRev = rev
            applyRemote(msg.state as SharedState)
          }
        }
        // After a reconnect our local state is at least as fresh as the
        // relay's (which may even have restarted) — push to converge.
        localRev = Math.max(localRev, maxSeenRev) + 1
        sendState()
        break
      }
      case 'state': {
        const rev = typeof msg.rev === 'number' ? msg.rev : 0
        if (rev > localRev && msg.state && typeof msg.state === 'object') {
          maxSeenRev = localRev = rev
          applyRemote(msg.state as SharedState)
        }
        break
      }
      case 'error': {
        if (msg.code === 'code_taken' && ws && wantedCode !== null) {
          // The rolled code is live on the relay already: re-roll (a
          // handful of times), then let the relay mint one. Collisions are
          // tolerated by design — ADR-0021.
          codeRerolls++
          if (codeRerolls <= CODE_REROLL_LIMIT) {
            wantedCode = generateRoomCode()
            ws.send(JSON.stringify({ type: 'create', code: wantedCode }))
          } else {
            wantedCode = null
            ws.send(JSON.stringify({ type: 'create' }))
          }
        } else {
          // Every other relay error, including `room_expired` (ADR-0026)
          // and `not_in_room`. The decision is pure + unit-tested in
          // src/lib/relayErrors.ts; the store only applies it.
          const outcome = describeRelayError(msg.code)
          if (outcome.retry === 'ignore') {
            // Review F6: OUR frame was refused (bad_state / bad_json /
            // unknown_type). The room and this socket are perfectly fine —
            // recycling the socket here would send `leave` and, if we are
            // the only peer, delete the very room we are standing in. Stay
            // live and let the next successful push carry the edit.
          } else if (outcome.retry === false) {
            // The room is gone for good: drop the stored code and stop.
            // Retrying would join-or-create a brand-new EMPTY room and
            // look like silent data loss to the household.
            if (outcome.message) error.value = outcome.message
            status.value = 'error'
            roomGone = true
            sessionStorage.removeItem(ROOM_CODE_KEY)
            cleanupSocket()
          } else if (code.value) {
            // Transient (rate_limited, or a keepalive that raced a room
            // teardown): stay in the backoff loop and re-join by code.
            scheduleReconnect(code.value)
          } else {
            error.value = outcome.message ?? 'Room error'
            status.value = 'error'
            cleanupSocket()
          }
        }
        break
      }
    }
  }

  function connect(role: 'create' | 'join', joinCode?: string) {
    // A deliberate connect clears the "room is gone" latch — including
    // the join-or-create path, where re-joining re-establishes the room.
    roomGone = false
    // Review F6: this socket is being RECYCLED, not left. Sending `leave`
    // would tell the relay we are done with a room we intend to re-join,
    // and as the last peer that deletes the room and its state for
    // everyone. The socket close detaches us anyway (and the re-join
    // re-seeds from our own persisted stores).
    cleanupSocket({ sendLeave: false })
    status.value = 'connecting'
    error.value = null

    const socket = new WebSocket(wsUrl())
    ws = socket

    socket.onopen = () => {
      if (role === 'create') {
        socket.send(JSON.stringify(wantedCode ? { type: 'create', code: wantedCode } : { type: 'create' }))
      } else {
        socket.send(JSON.stringify({ type: 'join', code: joinCode }))
      }
    }
    socket.onmessage = (event) => {
      try {
        handleMessage(JSON.parse(event.data as string))
      } catch {
        /* ignore malformed frames */
      }
    }
    socket.onclose = () => {
      if (ws !== socket) return // superseded by a newer connection
      ws = null
      stopKeepalive()
      if (roomGone) return // the room is gone: no reconnect loop
      if (!code.value) {
        // Room never established (initial connect dropped / join rejected).
        status.value = 'error'
        if (!error.value) error.value = 'Connection lost'
        return
      }
      // Once we have a code we always reconnect by re-joining it — even the
      // host, since the relay keeps the room (and its state) alive.
      scheduleReconnect(code.value)
    }
  }

  function scheduleReconnect(joinCode: string) {
    if (!code.value || roomGone) return
    status.value = 'connecting'
    // Review F5: never stack reconnects. An orphaned timer would fire
    // after a terminal error had latched `roomGone`, and its `connect()`
    // would clear that latch — i.e. resurrect a room the relay closed.
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** reconnectAttempts)
    reconnectAttempts++
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      // Re-check at FIRE time, not just at schedule time.
      if (roomGone || !code.value) return
      connect('join', joinCode)
    }, delay)
  }

  function cleanupSocket({ sendLeave = true }: { sendLeave?: boolean } = {}) {
    // Keepalive first: a leaked interval would keep sending into a dead
    // socket forever, and would keep a room alive that nobody is in.
    stopKeepalive()
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (pushTimer) {
      clearTimeout(pushTimer)
      pushTimer = null
    }
    if (ws) {
      const socket = ws
      ws = null
      // A recycled socket does not announce a leave (review F6): the
      // close below already detaches us, and `leave` would have the relay
      // delete a room we are about to re-join.
      if (sendLeave) {
        try {
          socket.send(JSON.stringify({ type: 'leave' }))
        } catch {
          /* already closing */
        }
      }
      socket.onclose = null
      socket.close()
    }
  }

  /**
   * Create a new room (host role). ADR-0021: the CODE is rolled here, on
   * the client, so the user can read it out before anyone joins; the relay
   * honours a free three-word code and refuses a taken one (we re-roll).
   */
  function create(preferredCode?: string) {
    reconnectAttempts = 0
    wantedCode = preferredCode ? normalizeRoomCode(preferredCode) : generateRoomCode()
    codeRerolls = 0
    connect('create')
  }

  /** Join an existing room by code (legacy or three-word, any spelling). */
  function join(codeToJoin: string) {
    const normalized = normalizeRoomCode(codeToJoin)
    if (!normalized) {
      error.value = 'That is not a room code'
      status.value = 'error'
      return
    }
    code.value = normalized
    sessionStorage.setItem(ROOM_CODE_KEY, code.value)
    reconnectAttempts = 0
    connect('join', code.value)
  }

  /**
   * Re-join the room stored by a previous session (page reload). Returns
   * true when a resume was started. Cheap no-op when not in a room.
   */
  function resume(): boolean {
    if (status.value !== 'idle') return false
    const stored = sessionStorage.getItem(ROOM_CODE_KEY)
    if (!stored) return false
    code.value = stored
    connect('join', stored)
    return true
  }

  /** Leave the current room and go back to idle. */
  function leave() {
    code.value = null
    status.value = 'idle'
    error.value = null
    reconnectAttempts = 0
    wantedCode = null
    roomGone = false
    sessionStorage.removeItem(ROOM_CODE_KEY)
    cleanupSocket()
  }

  return {
    // state
    status,
    code,
    error,
    // computed
    inRoom,
    // actions
    roomLink,
    roomLinkFor,
    create,
    join,
    resume,
    leave,
  }
})
