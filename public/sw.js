/*
 * Flambette household push notifications — the service worker (ADR-0102).
 *
 * The SW is the ONLY notification renderer: the relay fans a household
 * trigger out as a real Web Push message and THIS worker surfaces it, so a
 * household member hears the news with the app closed. The payload JSON is
 * built server-side by the shared relay core (`server/relay-core/push.ts`)
 * — the worker renders what arrives, it does not invent copy:
 *
 *   { title: string, body: string, tag?: string, url?: string }
 *
 * Anything unparseable or untitled is dropped silently: a notification is
 * best-effort by nature, and a malformed frame must never raise the app's
 * error surface. No badge/ icon configuration: the default browser icon is
 * used, same as the ADR's KISS ruling for the whole feature.
 *
 * Plain-HTTP LAN origins never load this file at all — registration is
 * guarded on secure context (`usePushSubscription`), so this code only ever
 * runs where push exists.
 */

/** Deep-link fallback for a payload that does not carry a usable `url`. */
const DEFAULT_URL = '/plan'
/** Coalescing tag: two triggers of one kind replace rather than stack. */
const DEFAULT_TAG = 'flambette-household'

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('push', (event) => {
  let payload = null
  try {
    payload = event.data ? event.data.json() : null
  } catch {
    payload = null
  }
  if (!payload || typeof payload !== 'object' || typeof payload.title !== 'string' || !payload.title) {
    return
  }
  const body = typeof payload.body === 'string' ? payload.body : ''
  const tag = typeof payload.tag === 'string' && payload.tag ? payload.tag : DEFAULT_TAG
  const url =
    typeof payload.url === 'string' && payload.url.startsWith('/') ? payload.url : DEFAULT_URL
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body,
      tag,
      // The deep link rides `data` (the notification's own payload): the
      // click handler reads it back without re-parsing anything.
      data: { url },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url =
    event.notification.data && typeof event.notification.data.url === 'string'
      ? event.notification.data.url
      : DEFAULT_URL
  event.waitUntil(focusOrNavigate(url))
})

/**
 * Focus an OPEN window of this app and point it at the deep link; open a
 * new one only when none exists. Navigating the focused window (instead of
 * just focusing it) is the whole point of the deep link — a plan-started
 * tap should land on the plan.
 */
async function focusOrNavigate(url) {
  const absolute = new URL(url, self.registration.scope).href
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  for (const client of windows) {
    if (!('focus' in client)) continue
    try {
      await client.focus()
      try {
        await client.navigate(absolute)
      } catch {
        // A cross-origin or un-navigable client still got focused; the
        // user is in the app either way.
      }
      return
    } catch {
      // Unfocusable client: keep looking for one that will take the link.
    }
  }
  await self.clients.openWindow(absolute)
}

/**
 * Key/subscription rotation (ADR-0102 §6): the SW does not know the VAPID
 * public key, so it cannot re-subscribe alone — it asks any open client to
 * run the composable's re-sync. With no client open, nothing happens and
 * the next app boot re-registers on room join; the rotation case is
 * therefore eventual, never an error.
 */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const client of windows) {
        try {
          client.postMessage({ type: 'push-resubscribe' })
        } catch {
          // A dying client is not a rotation blocker.
        }
      }
    })(),
  )
})
