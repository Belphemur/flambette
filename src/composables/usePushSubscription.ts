/**
 * Household push subscriptions (ADR-0102).
 *
 * The bridge between the device-local toggle (`ui.notificationSettings`,
 * ADR-0102), the browser's per-origin push state and the room relay:
 *
 * - **Registration** (`ensureServiceWorker`): `/sw.js` is registered at
 *   app boot, guarded on a SECURE context with the push APIs present — a
 *   plain-HTTP LAN origin has neither API and the composable becomes a
 *   no-op (never an error, matching the ADR's "unavailable" degradation).
 * - **Subscription sync** (`syncPushSubscription`): with the toggle ON, a
 *   live room and a granted permission, the device's `PushSubscription`
 *   (endpoint + keys) is pushed to the relay over the EXISTING WebSocket
 *   as a `push_register` frame — subscriptions never enter the room-sync
 *   payload, never join STORE_SLICES, never ride backup/restore (they are
 *   per-origin, per-device browser state owned by the server). With the
 *   toggle OFF, the browser subscription is released and the relay row is
 *   dropped (`push_unregister`).
 * - **Permission**: being ON is subscription-INTENT, not a granted
 *   permission. The prompt is offered on the FIRST room join after the
 *   feature ships and again from the Settings row; a decline leaves the
   * toggle ON with no subscription and the `asked` marker stops the
 *   automatic offer from repeating (the row still re-offers — a person
 *   pressing it is a deliberate gesture). A denied browser is simply
 *   unsubscribed, quietly.
 * - **VAPID**: the relay is the only party that knows the keys (Worker
 *   secrets / self-host env, ADR-0102). The CLIENT fetches the PUBLIC
 *   key from the relay's health payload once per page load; a relay with
 *   no VAPID configured answers `null` and the feature is silently off.
 *
 * The sync is deliberately a FUNCTION, not a watcher: the app shell and
 * the Settings row call it at the two moments the ADR names (room joined,
 * toggle flipped), and the SW's `pushsubscriptionchange` relay-message
 * calls it too. No watcher infers events.
 */

import { useRoomStore } from '../stores/room'
import { useUiStore } from '../stores/ui'

/* ------------------------------------------------------------------ cap */

/**
 * The honest capability test, mirrored in SettingsTab's `canNotify` note:
 * a service worker + PushManager on a SECURE origin. Plain-HTTP LAN
 * origins (the compose stack) have neither API.
 */
export function canPush(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    window.isSecureContext === true
  )
}

/* ------------------------------------------------------- SW registration */

let registrationPromise: Promise<ServiceWorkerRegistration | null> | null = null

/**
 * Register `/sw.js` once per page load (idempotent — repeat calls await
 * the same promise). Resolves null when the SW cannot exist (insecure
 * origin, no API) or the registration fails: a failed registration is a
 * "notifications unavailable" state, never an app error.
 */
export function ensureServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!canPush()) return Promise.resolve(null)
  registrationPromise ??= navigator.serviceWorker
    .register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
    .then((reg) => reg as ServiceWorkerRegistration)
    .catch(() => null)
  return registrationPromise
}

/* ------------------------------------------------------------ VAPID key */

let vapidKeyPromise: Promise<string | null> | null = null

/**
 * The relay origin the health payload answers on: an explicit
 * VITE_RELAY_WS_URL (the Cloudflare relay, cross-origin) unwrapped from its
 * ws scheme; otherwise the same origin the app was served from (dev/e2e
 * proxy, Docker compose, LAN).
 */
/** Exported for the unit spec (the ws→http scheme unwrap is pinned). */
export function relayBase(): string {
  const override = import.meta.env.VITE_RELAY_WS_URL
  if (override) {
    try {
      const url = new URL(override)
      // The override is a WEBSOCKET url (`wss://…`) — fetch() only speaks
      // http(s), so the ws scheme is unwrapped to its HTTP twin (the
      // health payload is served by the same relay over the same origin).
      if (url.protocol === 'wss:') url.protocol = 'https:'
      else if (url.protocol === 'ws:') url.protocol = 'http:'
      return url.origin
    } catch {
      // A nonsense override degrades to same-origin — the same fallback
      // the room store's wsUrl applies.
    }
  }
  return location.origin
}

/**
 * The relay's VAPID PUBLIC key, fetched once per page load. Null when the
 * relay has no keys configured (the feature is silently off) or the fetch
 * fails (best-effort, retried on the next sync call).
 */
/**
 * Test seam: the key memo is module state; the unit spec resets it so
 * each test starts with a clean page-load.
 */
export function resetVapidKeyMemoForTests(): void {
  vapidKeyPromise = null
}

/** Exported for the unit spec (the memoize-only-success contract). */
export function fetchVapidPublicKey(): Promise<string | null> {
  vapidKeyPromise ??= (async () => {
    try {
      const res = await fetch(`${relayBase()}/ws?vapid=1`, { method: 'GET' })
      if (!res.ok) {
        // A failed lookup is NOT memoized: clearing the promise lets the
        // next sync retry instead of disabling push for the whole page.
        vapidKeyPromise = null
        return null
      }
      const body = (await res.json()) as { vapidPublicKey?: unknown }
      const key =
        typeof body.vapidPublicKey === 'string' && body.vapidPublicKey ? body.vapidPublicKey : null
      if (!key) {
        // A definitive "no keys configured" IS cached — the answer is
        // the relay's configuration, not a transport failure.
        return null
      }
      return key
    } catch {
      vapidKeyPromise = null
      return null
    }
  })()
  return vapidKeyPromise
}

/** The subscription's `applicationServerKey` grammar: raw URL-base64. */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64.replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

/* ------------------------------------------------------------ sync paths */

/** Why a sync is running — the permission rules differ (see below). */
export type PushSyncReason = 'join' | 'toggle'

/* ---------------------------------------------------- gesture-routed ask */

/**
 * The Settings row's in-flight offer, set SYNCHRONOUSLY by
 * `offerPushPermissionFromGesture` inside the row's change handler and
 * consumed once by the next sync. Module-scoped: the handler and the
 * store watcher that follows it are different call frames.
 */
let gestureOffer: Promise<boolean> | null = null

/** The gesture offer's answer, consumed exactly once by the next sync. */
function takeGestureOffer(): Promise<boolean> | null {
  const offer = gestureOffer
  gestureOffer = null
  return offer
}

/**
 * Begin the browser's permission offer from a DIRECT user gesture (the
 * Settings row's change handler). Safari requires the request to be
 * initiated inside the gesture — before any await — so the row calls
 * this synchronously, and the sync that follows adopts its answer
 * instead of issuing a second prompt. The `asked` marker is spent HERE
 * (the Settings row re-offers on every deliberate press, so spending it
 * without a confirmed relay key cannot lock the feature out); the
 * AUTOMATIC join offer (below) validates the relay's key first and only
 * then marks + asks.
 */
export function offerPushPermissionFromGesture(): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'default') return
  const ui = useUiStore()
  gestureOffer ??= (async () => {
    ui.markNotificationAsked()
    return (await requestNotificationPermission()) === 'granted'
  })()
}

/**
 * Serialize subscription syncs: one runs at a time, in call order. Two
 * overlapping syncs would race the browser subscription and the relay
 * rows — an enable finishing AFTER an off sync released the endpoint
 * could register a subscription the user just turned off. A call that
 * arrives mid-flight waits for the running sync, then runs against
 * fresh state (and `doSync` re-checks its preconditions after every
 * await, so a state change mid-sync still wins).
 */
let syncChain: Promise<void> = Promise.resolve()

export function syncPushSubscription(reason: PushSyncReason): Promise<void> {
  const run = syncChain.then(() => doSync(reason))
  syncChain = run.catch(() => {})
  return run
}

/**
 * Bring this device's subscription in step with (toggle, permission,
 * room, relay). Serialized by `syncPushSubscription`; safe to call at
 * any moment from any surface: every gate below is a silent no-op on
 * its way out. State is RE-CHECKED after every await — a toggle flip or
 * a room change that lands mid-sync must win over this sync's older
 * intent.
 */
async function doSync(reason: PushSyncReason): Promise<void> {
  const room = useRoomStore()
  const ui = useUiStore()
  const settings = ui.notificationSettings

  // OFF is a full opt-out: release the browser subscription AND tell the
  // relay to drop the row. Runs even where push cannot exist — nothing to
  // release there, and the relay row (if any) still dies.
  if (!settings.enabled) {
    await releaseSubscription()
    return
  }

  if (!canPush()) return
  // Only a LIVE room has a relay to register against (and a room code the
  // subscription is keyed by). Reconnecting lands here again.
  if (room.status !== 'live' || !room.code) return
  const registration = await ensureServiceWorker()
  if (!registration || !ui.notificationSettings.enabled) return

  // A gesture offer (the Settings row) takes precedence: its prompt was
  // already requested synchronously inside the user gesture (Safari
  // requires that), so the sync only adopts its answer.
  const gesture = takeGestureOffer()
  if (gesture) {
    if (!(await gesture) || !ui.notificationSettings.enabled) return
  } else {
    // The relay's PUBLIC key must exist BEFORE the automatic offer is
    // spent: on a keyless deployment the prompt (and the one-time
    // `asked` marker) would be burned on a feature that cannot deliver.
    const vapidKey = await fetchVapidPublicKey()
    if (!vapidKey || !ui.notificationSettings.enabled) return

    // Permission. Denied: nothing will ever be shown — quietly out.
    // Default: the ONE offer rules (module doc) — the automatic join
    // offer runs once per device (`asked`), the Settings row's own
    // toggle always re-offers because a person pressing it is a
    // deliberate gesture.
    const permission =
      typeof Notification !== 'undefined' ? Notification.permission : ('denied' as const)
    if (permission === 'denied') return
    if (permission === 'default') {
      if (reason === 'join' && settings.asked) return
      ui.markNotificationAsked()
      const granted = await requestNotificationPermission()
      if (granted !== 'granted' || !ui.notificationSettings.enabled) return
    }
  }

  // The relay's PUBLIC key. Without it there is nothing to subscribe to
  // (the gesture path lands here first — its prompt beat the key lookup
  // to stay inside the user gesture).
  const vapidPublicKey = await fetchVapidPublicKey()
  if (!vapidPublicKey || !ui.notificationSettings.enabled) return

  let subscription = await registration.pushManager.getSubscription()
  if (!subscription) {
    try {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      })
    } catch {
      // A refused subscription (browser policy, expired key) is the same
      // "unsubscribed" Settings state as a decline — never an error.
      return
    }
  }
  // Last re-check before the register: the subscription about to be
  // published describes the CURRENT room and the CURRENT preference.
  if (!ui.notificationSettings.enabled || room.status !== 'live' || !room.code) {
    if (!ui.notificationSettings.enabled) await releaseSubscription()
    return
  }
  const json = subscription.toJSON()
  const keys = json.keys as { p256dh?: unknown; auth?: unknown } | undefined
  if (!subscription.endpoint || typeof keys?.p256dh !== 'string' || typeof keys?.auth !== 'string') {
    return
  }
  // The sender's own subscription is excluded from every fan-out (the
  // actor does not get pinged for their own action) — the endpoint is how
  // the relay tells the actor's row apart, so the room store carries it.
  room.setPushSelfEndpoint(subscription.endpoint)
  room.sendPushRegister(subscription.endpoint, {
    p256dh: keys.p256dh,
    auth: keys.auth,
  })
}

/**
 * Release the browser subscription and drop the relay row. Best-effort:
 * a failed browser unsubscribe still sends the unregister, and vice versa.
 */
async function releaseSubscription(): Promise<void> {
  const room = useRoomStore()
  const endpoint = room.pushSelfEndpoint
  if (endpoint) room.sendPushUnregister(endpoint)
  room.setPushSelfEndpoint(null)
  if (!canPush()) return
  try {
    const registration = await ensureServiceWorker()
    const subscription = await registration?.pushManager.getSubscription()
    if (subscription) await subscription.unsubscribe()
  } catch {
    // A browser that refuses to release keeps its subscription until it
    // expires on its own; the relay row is already gone.
  }
}

/** One place that asks the browser, so the callback/promise duality is not spelled twice. */
function requestNotificationPermission(): Promise<NotificationPermission> {
  return new Promise((resolve) => {
    try {
      const result = Notification.requestPermission((answer) => resolve(answer))
      if (result && typeof result.then === 'function') result.then(resolve)
    } catch {
      resolve('denied')
    }
  })
}

/**
 * The SW's `pushsubscriptionchange` relay message (public/sw.js): re-run
 * the sync as a deliberate gesture. Eventual by design — with no client
 * open, the next boot's room join re-registers instead.
 */
export async function resubscribeFromServiceWorker(): Promise<void> {
  await syncPushSubscription('toggle')
}


