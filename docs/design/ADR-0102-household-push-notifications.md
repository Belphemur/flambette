# ADR-0102: Household Push Notifications (Web Push via the relay)

Status: accepted (2026-11-16)

## Context

A household member currently learns that someone else started a meal plan
or finished the grocery list only by opening the app and noticing the
changed room state. The room WebSocket (ADR-0026, ADR-0088) reaches devices
that have the app open; there is no way to reach a phone whose browser is
closed. The owner wants a notification delivered to every member of the
room — including people not on the page — when:

1. **A meal plan is started**: the first recipe lands on an otherwise
   EMPTY plan (manual add or Auto-Plan apply both count). Cooking a meal
   that auto-creates a plan does NOT notify. Later adds do NOT notify.
2. **The grocery is finished**: every grocery line is checked
   (all-checked, the moment the last line is checked).

## Decision

1. **Transport is real Web Push, not foreground notifications.** The app
   ships a service worker (`/sw.js`) registered on app boot that handles
   `push` events → `showNotification`. A push subscription
   (`PushSubscription`: endpoint + keys) is registered per DEVICE and
   stored SERVER-SIDE, keyed by room code — subscriptions never enter the
   room-sync payload, never join STORE_SLICES, never ride backup/restore
   (they are per-origin, per-device browser state owned by the server).
2. **The relay becomes a push sender, on BOTH runtimes.** The Cloudflare
   Room DO (`server/worker/`) and the self-hosted Bun relay
   (`server/relay-core/`) each gain a fan-out path that sends the Web
   Push payload to every subscription registered for the room. The
   fan-out is ONE shared helper (shared TS core per the ADR-0040
   seam) — never two implementations. VAPID keys: Cloudflare carries
   them as Worker secrets; self-hosters generate their own
   (`web-push generate-vapid-keys`) and pass them via env/config. A
   relay with no VAPID keys configured disables the notification
   feature silently and does not error.
3. **Setting**: "Household notifications", ON by default, DEVICE-LOCAL
   (persisted slice + STORE_SLICES entry, like the ADR-0081 timer-alert
   settings). The toggle never enters the room payload (same ruling
   family as ADR-0037's device-local defaults). Being ON is a
   subscription-intent, not a granted permission: the browser permission
   prompt is offered on first room join after the feature ships (and
   again from the Settings row); declining leaves the toggle ON with no
   subscription and no repeated nagging.
4. **Trigger points (client-side, the single write-site rule)**:
   - `plan-started`: fires when a plan transition goes 0 → ≥1 entries
     and the transition was NOT caused by a cook's auto plan-creation
     (the recordCook path marks its plan mutation as notification-exempt
     at the ONE mutation site in the plan store — no watcher infers
     cause).
   - `grocery-finished`: fires on the false→true transition of
     "all lines checked" (the same all-checked predicate GroceryTab's
     auto-collapse already computes — reused, never re-derived), plus a
     per-transaction notification latch so a burst of final checks sends
     exactly one notification.
   - The SENDER's own subscription is excluded from the fan-out (the
     actor does not get pinged for their own action).
5. **Trigger relay, not page state**: the client asks the relay to fan
   out (`notify` message over the existing WebSocket); the relay owns
   the send. Page-local `showNotification` is NOT the mechanism. The
   server deduplicates per trigger key+room (short window) so a flapping
   last-line check cannot spam the household.
6. **Subscription lifecycle**: re-subscribe when the browser rotates
   keys or the push subscription changes; on `410 Gone`/`404` from a
   push service the relay prunes that subscription row. A device that
   toggles OFF unsubscribes server-side.
7. **Design authority (adopted render)**: Stitch project
   2725470430841257407 ("Flambette Recipe App", Warm Culinary Paper),
   screens `ca8ee9f9833d4b52be2091579d80f32a` (Settings, Mobile) and
   `1dc6644bea39492394d7d0a466492376` (Settings, Desktop) — "Settings
   (Notifications Card Variant 1)": a dedicated **"Household
   Notifications" card** right after the Household Room card, one row
   ("Notify the household" + push description + ON-state toggle).
   Variant 2 (integrated row inside the Household Room card) is
   recorded as the explored alternative, not adopted. The exported
   HTML renders were verified (Warm Culinary Paper tokens only; the
   generator's off-token hexes `#E5D8CB`/`#FFF8F0` map to repo tokens
   per the standing hex-mapping rule) and its icon is Material Symbols
   `notifications_active` → the repo's bundled lucide `Bell`
   (unclaimed semantics, grep-verified) at adoption time.

## Decision log (coding-philosophy: DRY > SOLID > KISS)

- **DRY**: the all-checked predicate is the ONE GroceryTab already
  computes for auto-collapse — the trigger reuses it instead of a second
  derivation; the fan-out sender is ONE shared core helper used by both
  runtimes; the toggle is the ONE `notificationSettings` field, never a
  parallel room-synced copy.
- **SOLID (correctness beats simplicity)**: the cook-path exemption is
  marked at the plan store's single mutation site rather than inferred,
  because a watcher-based cause heuristic races the 0→1 transition it
  classifies; the relay deduplicates and prunes dead subscriptions
  server-side, never trusting the client to be the only writer; the
  notification latch is per-transaction so concurrent check bursts cannot
  double-send.
- **KISS**: no queue, no retry worker, no third-party push facade —
  the relay sends best-effort and prunes on failure codes; no
  foreground-toast surface duplicates the SW notification (the SW is the
  only notification renderer); subscriptions are opaque rows keyed by
  (room, subscription endpoint), no device-identity join.

## Consequences

- The SPA gains a service worker file at the Vite public root and a
  registration + subscription composable; the DO and relay-core each
  gain the fan-out over their existing per-room store. Web-push crypto
  (VAPID JWT + payload encryption) is the main new dependency surface —
  evaluate the zero-dep constraint (ADR-0088 relay core is
  dependency-free) and record the chosen approach in the PR; an
  in-core implementation is acceptable if the dependency is judged too
  heavy for the shared core, but it must then be the ONLY
  implementation (DRY again).
- Notifications are best-effort by nature (browser may not have granted
  permission, relay may lack VAPID keys, devices may be offline too
  long for Google/Apple/Mozilla push endpoints) — the app must never
  surface notification failure as an error, only as an unsubscribed
  Settings state.
- e2e can exercise the triggers (empty→first add, last check) and the
  Settings toggle, but the actual push send happens server-side;
  relay-core unit tests pin the fan-out + dedupe + prune behaviour.
- Self-hosted relays upgrade inert: no VAPID keys → feature off, rooms
  keep working unchanged.

## Alternatives considered

- **Foreground-only notifications** (no SW): rejected — fails the
  stated requirement that the person need not be on the page.
- **Room-synced toggle**: rejected — browser permission is per-device,
  so one shared switch would lie about half the household.
- **A third-party push relay service (OneSignal etc.)**: rejected —
  new vendor + network dependency in an offline-first app whose only
  server relationship is the room relay.
- **Notify on every plan add**: rejected — noisy; only the plan-START
  moment is news.
