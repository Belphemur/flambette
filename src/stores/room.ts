import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { generateRoomCode, normalizeRoomCode } from '../lib/roomWords'
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
/** Re-rolls of a taken three-word code before falling back to a relay-minted one. */
const CODE_REROLL_LIMIT = 3

/** Session-scoped storage of the room code: survives reloads, not tab closes. */
const ROOM_CODE_KEY = 'mealime-planner:v1:room-code'

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
  /** True while we're writing a remote snapshot into the local stores. */
  let applyingRemote = false
  /** The three-word code we asked the relay to create with (ADR-0021). */
  let wantedCode: string | null = null
  let codeRerolls = 0

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
      ws.send(JSON.stringify({ type: 'state', rev: localRev, state: snapshot() }))
    }, PUSH_DEBOUNCE_MS)
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

  /* ---------- connection ---------- */

  function handleMessage(msg: Record<string, unknown>) {
    switch (msg.type) {
      case 'created': {
        code.value = typeof msg.code === 'string' ? msg.code : null
        if (code.value) sessionStorage.setItem(ROOM_CODE_KEY, code.value)
        status.value = 'live'
        reconnectAttempts = 0
        // Seed the room with our current state.
        localRev = maxSeenRev + 1
        ws?.send(JSON.stringify({ type: 'state', rev: localRev, state: snapshot() }))
        break
      }
      case 'joined': {
        status.value = 'live'
        reconnectAttempts = 0
        if (msg.state != null) {
          const rev = typeof msg.rev === 'number' ? msg.rev : localRev + 1
          if (rev > localRev) {
            maxSeenRev = localRev = rev
            applyRemote(msg.state as SharedState)
          }
        }
        // After a reconnect our local state is at least as fresh as the
        // relay's (which may even have restarted) — push to converge.
        localRev = Math.max(localRev, maxSeenRev) + 1
        ws?.send(JSON.stringify({ type: 'state', rev: localRev, state: snapshot() }))
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
        if (msg.code === 'not_found') {
          error.value = 'Room not found — it may have expired'
          status.value = 'error'
          sessionStorage.removeItem(ROOM_CODE_KEY)
          cleanupSocket()
        } else if (msg.code === 'code_taken' && ws && wantedCode !== null) {
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
          // Unknown error (rate_limited, banned code shape, ...): surface it
          // instead of spinning in 'connecting' forever. A CI relay under a
          // throttle hung every room spec exactly this way — the chip sat at
          // "◌ Connecting" for the full timeout with nothing in the logs.
          error.value = `Room error — ${String(msg.code ?? 'unknown')}`
          status.value = 'error'
          cleanupSocket()
        }
        break
      }
    }
  }

  function connect(role: 'create' | 'join', joinCode?: string) {
    cleanupSocket()
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
    if (!code.value) return
    status.value = 'connecting'
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** reconnectAttempts)
    reconnectAttempts++
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect('join', joinCode)
    }, delay)
  }

  function cleanupSocket() {
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
      try {
        socket.send(JSON.stringify({ type: 'leave' }))
      } catch {
        /* already closing */
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
