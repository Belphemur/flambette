/**
 * The relay's push fan-out (ADR-0102) — ONE shared core helper, consumed
 * identically by BOTH runtimes (ADR-0040's seam: the adapters own sockets
 * and storage APIs, the core owns every decision).
 *
 * What lives here, so the two relays cannot drift:
 *
 * - **The trigger vocabulary and the notification copy** — the client
 *   sends only a key; the payload JSON (title/body/deep-link tag) is built
 *   HERE, once, so every household member's notification reads the same
 *   regardless of which peer's client asked for the fan-out.
 * - **Registration** — opaque rows keyed (room code, subscription
 *   endpoint), stored through the injected facade (SQLite on both
 *   runtimes, ADR-0088's storage philosophy: subscriptions survive relay
 *   restarts because the phone that owns one may be closed for days).
 *   Subscriptions NEVER ride the room-sync payload — they are server-
 *   owned per-device state, deliberately outside `SYNCED_STORES`.
 * - **Dedupe** — per (room, trigger key) inside a short window, so a
 *   flapping last-line check or a room-wide echo storm sends once.
 *   In-memory by design: the window is seconds-scale and best-effort.
 * - **Delivery** — best-effort, never an error surface: each send is
 *   wrapped, failures logged (when a logger is supplied) and skipped; a
 *   410/404 prunes the dead row right here, at the one place that knows
 *   which row it just tried.
 * - **No-VAPID inertness** — a relay with no keys configured answers
 *   `notify` with silence: no send, no error frame, the room keeps
 *   working unchanged (ADR-0102's upgrade-inert ruling).
 */

import { b64urlDecode, sendWebPush, type VapidConfig } from './webpush'

/** One household event a member can be pushed about (mirrors the client's `src/lib/pushKeys.ts`). */
export type NotifyKey = 'plan-started' | 'grocery-finished'

/** The runtime list — the frame gate refuses anything outside it. */
export const NOTIFY_KEYS: readonly NotifyKey[] = ['plan-started', 'grocery-finished']

export function isNotifyKey(value: unknown): value is NotifyKey {
  return typeof value === 'string' && (NOTIFY_KEYS as readonly string[]).includes(value)
}

/** The deep link each trigger opens (SPA paths, relative to the web origin). */
const NOTIFY_PAYLOAD: Record<NotifyKey, { title: string; body: string; url: string }> = {
  'plan-started': {
    title: 'Meal plan started',
    body: 'Someone in your household started a meal plan.',
    url: '/plan',
  },
  'grocery-finished': {
    title: 'Grocery list finished',
    body: 'Every item on the household grocery list is checked off.',
    url: '/grocery',
  },
}

/**
 * The wire payload ONE trigger becomes — JSON with the notification copy,
 * the coalescing tag and the deep link (the exact shape `public/sw.js`
 * renders). Exported for the specs: the delivery tests cannot read the
 * copy out of an encrypted envelope, so the construction is pinned here.
 */
export function notifyPayload(key: NotifyKey): string {
  return JSON.stringify({ ...NOTIFY_PAYLOAD[key], tag: `flambette:${key}` })
}

/** The subscription keys a client registers, verbatim from PushSubscription. */
export interface PushKeys {
  p256dh: string
  auth: string
}

/** One stored subscription row, as the core reads and sends it. */
export interface PushSubscriptionRow {
  endpoint: string
  keys: PushKeys
}

/**
 * The fan-out's storage facade — the same "adapter owns state" seam as
 * `RoomStore` (ADR-0040): the Bun adapter backs it with its relay SQLite
 * database, the Durable Object with its per-room storage SQL, the specs
 * with a Map. Synchronous by contract: both runtimes' storage is sync.
 */
export interface PushStore {
  /** Every subscription registered for this room code. */
  list(code: string): PushSubscriptionRow[]
  /** Upsert one subscription for this room code. */
  register(code: string, row: PushSubscriptionRow, now: number): void
  /** Forget one subscription (toggle-off, or the prune-on-410 path). */
  unregister(code: string, endpoint: string): void
  /** Forget the room's subscriptions entirely (the room is gone). */
  drop(code: string): void
  /**
   * Bound the room's rows to `cap`, evicting the OLDEST `updated_at`
   * first (the per-room quota, ADR-0102 hardening — the core owns the
   * decision, the adapters own the SQL).
   */
  trim(code: string, cap: number): void
}

/** How long one (room, key) trigger is suppressed after a send. */
export const NOTIFY_DEDUPE_MS = 60_000

/**
 * The push-subscription cap per room (ADR-0102 hardening): a room's
 * devices are a handful, so 32 rows is orders of magnitude above real
 * use while bounding both the storage a `push_register` storm can consume
 * and the number of sequential sends one `notify` can trigger.
 */
export const PUSH_ROOM_CAP = 32

/**
 * The endpoint URL's length cap (ADR-0102 hardening). Real push-service
 * endpoints are ~150 chars; 2048 is a generous ceiling that keeps a
 * junk frame from parking arbitrary-length strings in storage.
 */
export const PUSH_ENDPOINT_MAX_LENGTH = 2048

/**
 * The subscription key strings' length caps. A p256dh is the base64url
 * of a 65-byte point (87 chars) and an auth secret 16+ bytes (22 chars);
 * 512 lets padding variants through while bounding junk.
 */
const PUSH_KEY_MAX_LENGTH = 512

/**
 * The push-service hosts a subscription endpoint may live on. A room
 * member can already reach the relay, so without this gate they could
 * turn it into a proxy that POSTs VAPID-signed, encrypted payloads to
 * ANY https host (internal services included) — the fan-out's outbound
 * requests are confined to the real push services (ADR-0102 hardening).
 */
const ALLOWED_ENDPOINT_HOSTS = [
  'fcm.googleapis.com', // Chrome / Android (FCM)
  'push.services.mozilla.com', // Firefox (updates.push.services.mozilla.com)
  'notify.windows.com', // Edge / Windows (wns2-*.notify.windows.com)
  'web.push.apple.com', // Safari
] as const

/**
 * Whether `endpoint` is a subscription URL the relay will fan out to.
 * The four real push services only, https on the default port, never an
 * IP literal, a localhost/`.local` name or an oversized URL — everything
 * else is refused at registration, the ONLY ingress this table has.
 */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  if (!endpoint.startsWith('https://')) return false
  if (endpoint.length > PUSH_ENDPOINT_MAX_LENGTH) return false
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.port !== '') return false
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false // IPv4 literal
  if (host.includes(':')) return false // IPv6 literal
  return ALLOWED_ENDPOINT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
}

export interface PushFanout {
  register(code: string, row: PushSubscriptionRow, now: number): void
  unregister(code: string, endpoint: string): void
  drop(code: string): void
  /**
   * Fan ONE trigger out to every subscription registered for the room,
   * except the sender's own. NEVER throws and NEVER blocks the caller:
   * the returned promise settles when every send attempt has finished,
   * and a failed send is logged and skipped inside it. The Bun adapter
   * ignores the promise (fire-and-forget by design — its handler must
   * not wait on network sends); the Worker adapter hands it to
   * `ctx.waitUntil` so the runtime keeps the delivery alive past the
   * message handler's return.
   */
  notify(code: string, key: NotifyKey, options?: { self?: string; now?: number }): Promise<void>
}

/**
 * Build the fan-out. `vapid === null` is the "feature off" configuration —
 * registration still works (rows accumulate), `notify` stays a no-op, and
 * the relay never errors.
 */
export function createPushFanout(config: {
  vapid: VapidConfig | null
  store: PushStore
  now: () => number
  /** Optional; both runtimes have console. The specs stay silent. */
  log?: (message: string) => void
  fetchImpl?: typeof fetch
}): PushFanout {
  const { vapid, store, now } = config
  const log = config.log ?? (() => {})
  const fetchImpl = config.fetchImpl ?? fetch
  /** Last send timestamp per (code, key) — the dedupe window's memory. */
  const lastSent = new Map<string, number>()

  function notify(
    code: string,
    key: NotifyKey,
    options?: { self?: string; now?: number },
  ): Promise<void> {
    // No VAPID keys: silently off. The registration rows may still exist;
    // nothing is sent and nothing is pruned (the rows are cheap, and a
    // later configuration refreshes the relay with real send ability).
    if (!vapid) return Promise.resolve()
    const at = options?.now ?? now()
    const dedupeKey = `${code}\u0000${key}`
    const previous = lastSent.get(dedupeKey)
    if (previous !== undefined && at - previous < NOTIFY_DEDUPE_MS) {
      return Promise.resolve()
    }
    lastSent.set(dedupeKey, at)
    // The promise is handed back to the caller; its catch keeps the
    // contract "never rejects" while the failure is still logged.
    return fanOut(code, key, options?.self).catch((err) => {
      log(`[relay] push fan-out failed: ${(err as Error).message}`)
    })
  }

  /** The async half of `notify` — one caller, one catch, by construction. */
  async function fanOut(code: string, key: NotifyKey, self?: string): Promise<void> {
    const payload = notifyPayload(key)
    for (const row of store.list(code)) {
      // The actor does not get pinged for their own action (ADR-0102 §4).
      if (self && row.endpoint === self) continue
      try {
        const result = await sendWebPush(
          row.endpoint,
          row.keys,
          payload,
          vapid!,
          now(),
          fetchImpl,
        )
        if (result.gone) {
          // 410 Gone / 404 Not Found: the subscription is dead — the one
          // place that knows the endpoint prunes it (ADR-0102 §6).
          store.unregister(code, row.endpoint)
        } else if (!result.ok) {
          log(`[relay] push to ${row.endpoint} answered ${result.status}`)
        }
      } catch (err) {
        // Transport failure (network, DNS): best-effort, next trigger
        // retries. The row is KEPT — the endpoint may still be alive.
        log(`[relay] push to ${row.endpoint} failed: ${(err as Error).message}`)
      }
    }
  }

  return {
    register: (code, row, at) => {
      store.register(code, row, at ?? now())
      // The room's row count is the quota: evict the stalest device rows
      // so one member cannot grow the table or the fan-out without bound.
      store.trim(code, PUSH_ROOM_CAP)
    },
    unregister: (code, endpoint) => store.unregister(code, endpoint),
    drop: (code) => {
      store.drop(code)
      lastSent.delete(`${code}\u0000plan-started`)
      lastSent.delete(`${code}\u0000grocery-finished`)
    },
    notify,
  }
}

/**
 * Validate a `push_register` frame's payload. Returns the row, or null
 * when the frame is malformed — an unusable claim is silence (the room is
 * fine), never an error frame: a notification is best-effort by nature
 * and a bad frame must not disturb the room's sync surface.
 *
 * The endpoint is confined to the real push services (`isAllowedPushEndpoint`):
 * a room-code holder is already inside the relay, and the fan-out turns
 * every stored row into an outbound VAPID-signed POST — without the
 * allow-list that is an SSRF dial to any https host. Key strings are
 * length-capped for the same storage-abuse reason.
 */
export function parsePushRegistration(value: {
  endpoint?: unknown
  keys?: unknown
}): PushSubscriptionRow | null {
  const endpoint = value.endpoint
  if (typeof endpoint !== 'string' || !isAllowedPushEndpoint(endpoint)) return null
  const keys = value.keys
  if (typeof keys !== 'object' || keys === null) return null
  const { p256dh, auth } = keys as Record<string, unknown>
  if (typeof p256dh !== 'string' || !p256dh || p256dh.length > PUSH_KEY_MAX_LENGTH) return null
  if (typeof auth !== 'string' || !auth || auth.length > PUSH_KEY_MAX_LENGTH) return null
  return { endpoint, keys: { p256dh, auth } }
}

/**
 * Parse the VAPID configuration from raw env strings — the same
 * "adapter reads config, core judges" shape as `parsePositiveNumber`.
 * All-or-nothing: a partial configuration is NO configuration (a relay
 * with a public key but no private one must not half-work), and a
 * malformed pair is silently inert rather than fatal — the relay must
 * not refuse to serve rooms over a broken notification config.
 */
export function parseVapidConfig(raw: {
  publicKey?: string | null
  privateKey?: string | null
  subject?: string | null
}): VapidConfig | null {
  if (!raw.publicKey || !raw.privateKey) return null
  // Shape-validate BEFORE the fan-out is built: a half-decodable or
  // wrong-sized pair must be inert from boot, not half-enabled until the
  // first send throws (the same all-or-nothing ruling as above).
  try {
    const point = b64urlDecode(raw.publicKey)
    if (point.length !== 65 || point[0] !== 4) return null
    if (b64urlDecode(raw.privateKey).length !== 32) return null
  } catch {
    return null
  }
  return {
    publicKey: raw.publicKey,
    privateKey: raw.privateKey,
    ...(raw.subject ? { subject: raw.subject } : {}),
  }
}
