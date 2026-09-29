import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { generateRoomCode, normalizeRoomCode } from '../lib/roomWords'
import { describeRelayError } from '../lib/relayErrors'
import {
  mergeSharedFilters,
  normalizeQuickFilters,
  sameQuickFilters,
  toSharedFilters,
  type SharedQuickFilters,
} from '../lib/quickFilters'
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
  /**
   * Household half of the quick filters (ADR-0028). `favOnly` is
   * deliberately NOT carried: the favourites set is personal, so sharing
   * the switch would blank a peer's Recipes tab (see quickFilters.ts).
   * OPTIONAL: a peer running older code sends no `filters` key, and
   * receiving a payload WITHOUT it must leave the local selection
   * untouched (never a wipe).
   */
  filters?: SharedQuickFilters
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
  /**
   * True from the moment a local edit is queued for push until that push
   * has actually gone out.
   *
   * Without it, a 300ms debounce window loses local intent: A taps a
   * filter, B's older snapshot arrives in that window, A adopts it, and
   * the push A then sends (built from the now-remote state) re-broadcasts
   * B's value — the household permanently converges on the WRONG answer
   * even though A's tap was the newer fact. A queued local edit therefore
   * outranks a snapshot that arrives before its push: our push is sent at
   * a strictly higher rev, so the deferred snapshot is older by the time
   * it would be applied and is dropped by the usual `rev >` test.
   */
  let localEditPending = false
  /**
   * True when a local edit could NOT be pushed because the socket was not
   * live. Without it, tapping a filter during the ~1s a room takes to come
   * up loses the edit SILENTLY: the join response then adopts the room's
   * older snapshot over it, and nothing ever republishes. Holding the flag
   * makes the edit outrank that snapshot — we are the only party that can
   * prove our state is newer — and `sendState` clears it.
   */
  let unsentLocalEdit = false
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
      // Household state (ADR-0028): the shared half of the quick filters.
      filters: toSharedFilters(ui.quickFilters),
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
      // Quick filters (ADR-0028). ABSENCE means "don't touch": an older
      // peer sends no `filters` key, and treating that as an empty
      // selection would wipe the household's filters on every push. The
      // personal `favOnly` half is re-applied from local, never from the
      // wire.
      const filters = normalizeQuickFilters(state.filters)
      if (filters) {
        const merged = mergeSharedFilters(filters, ui.quickFilters)
        if (!sameQuickFilters(merged, ui.quickFilters)) ui.quickFilters = merged
      }
    } finally {
      applyingRemote = false
    }
  }

  /* ---------- push (debounced) ---------- */

  function schedulePush() {
    if (applyingRemote) return
    if (status.value !== 'live') {
      // The edit is real and must survive the join that is still in
      // flight: remember it, and let the join handler publish it.
      //
      // Only while we are actually ON OUR WAY INTO a room. With no room
      // at all (status idle, code null) there is nothing to publish
      // into, and carrying the flag would make a join much later skip
      // adoption and push a stale local plan over the household's — the
      // exact overwrite this flag exists to prevent.
      if (code.value !== null) unsentLocalEdit = true
      return
    }
    localEditPending = true
    if (pushTimer) clearTimeout(pushTimer)
    pushTimer = setTimeout(() => {
      pushTimer = null
      if (status.value !== 'live' || !ws || ws.readyState !== WebSocket.OPEN) {
        // The socket went away inside the debounce window: the edit never
        // reached the room and must be published on the next join.
        if (code.value !== null) unsentLocalEdit = true
        return
      }
      localRev = Math.max(localRev, maxSeenRev) + 1
      sendState()
    }, PUSH_DEBOUNCE_MS)
  }

  /** One place that writes a snapshot, so the rev floor (F4) is never missed. */
  function sendState() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    // The queued edit is now on the wire; later snapshots may apply again.
    localEditPending = false
    unsentLocalEdit = false
    writeRevFloor(code.value, localRev)
    ws.send(JSON.stringify({ type: 'state', rev: localRev, state: snapshot() }))
  }

  /**
   * Take delivery of an inbound snapshot. The REVISION is always absorbed
   * — it is proof of ordering, and dropping it would let our next push
   * reuse a rev the room has already passed, so peers would ignore it.
   * Only the CONTENT is withheld while a local edit is still queued: our
   * push is sent at a strictly higher rev and carries our whole state, so
   * the withheld snapshot is older by the time it would have been applied.
   */
  function acceptRemote(rev: number, state: unknown) {
    maxSeenRev = localRev = rev
    if (localEditPending) return
    applyRemote(state as SharedState)
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
        ui.quickFilters, // quick filters are household state (ADR-0028)
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
        let adopted = false
        if (msg.state != null && !unsentLocalEdit) {
          const rev = typeof msg.rev === 'number' ? msg.rev : localRev + 1
          // Newer than what we hold AND at least as new as anything this
          // session already proved for this code (review F4): a room
          // re-created after a restart must not talk a member that has
          // been at revision 9 back down to an empty plan at 2.
          if (rev > localRev && rev >= readRevFloor(code.value)) {
            maxSeenRev = localRev = rev
            applyRemote(msg.state as SharedState)
            adopted = true
          }
        }
        // Converge by pushing unless we just adopted the room's state, and
        // ALWAYS when we hold edits that were never delivered.
        //
        // A joiner that echoes the snapshot it just applied re-publishes
        // it at a HIGHER rev, and a snapshot can be stale by exactly the
        // in-flight window: a peer whose edit has not reached the relay
        // yet. The echo then wins the rev race and freezes the household
        // on the OLD state, with nothing left to correct it (the peer's
        // pending push is older). Adopting a snapshot leaves our state
        // byte-identical to the room's, so that echo is never needed to
        // converge — it only creates a way to lose a peer's newer edit.
        if (!adopted || unsentLocalEdit) {
          localRev = Math.max(localRev, maxSeenRev) + 1
          sendState()
        }
        break
      }
      case 'state': {
        const rev = typeof msg.rev === 'number' ? msg.rev : 0
        if (rev > localRev && msg.state && typeof msg.state === 'object') {
          acceptRemote(rev, msg.state)
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
    // A queued edit cancelled here never reached the room: carry it as an
    // UNSENT edit so the next join publishes it instead of adopting an
    // older snapshot over it. Without this, a socket drop inside the
    // 300ms debounce silently loses the tap.
    if (localEditPending || pushTimer) unsentLocalEdit = true
    // A queued edit can never reach the wire now; keeping the flag would
    // make the re-join ignore the room's snapshot FOREVER (a stuck
    // localEditPending is a permanent "don't apply remote state").
    localEditPending = false
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
    // A DELIBERATE new room: whatever the last one left unsent is not
    // this room's business, and publishing it would overwrite the new
    // room's state before it exists.
    unsentLocalEdit = false
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
    // A join into a DIFFERENT code starts clean: an undelivered edit
    // belongs to the room we were in, not to this one. A re-join of the
    // SAME code (resume, reconnect) keeps it — that is the case it is for.
    if (code.value !== normalized) unsentLocalEdit = false
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
    // Leaving ends the room's business: the local state is simply this
    // device's again, and a later join must adopt, not republish. After
    // cleanupSocket, so a push cancelled by the teardown cannot set it.
    unsentLocalEdit = false
    localEditPending = false
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
