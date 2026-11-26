# ADR-0104: Timer alarms get a visual shake channel and fire reliably on Brave/Android

Status: accepted (2026-11-26)

## Context

ADR-0093's recurring escalating alarm has exactly two output channels — the
synthesized chime (Web Audio) and `navigator.vibrate` — plus a STATIC banner
(`alarmingTimers` → the app shell's "timer is ringing — Stop" strip) that
does not move. On Brave for Android the owner reports NEITHER channel
fires: no ring, no vibration, nothing but the countdown reaching zero.

Root causes, traced through the engine (`src/lib/timerAlert.ts`) and host
(`src/lib/timerAlertHost.ts`):

1. **Silent audio degradation is total on Brave.** `chime()` returns early
   unless `ctx.state === 'running'`. Brave's autoplay/shields handling can
   leave the unlocked context `suspended` (the `unlock()` resume promise is
   swallowed by design), so every round of the alarm no-ops the chime with
   no signal that anything was attempted.
2. **Vibration is gated on the same engine call path and on activation
   state.** `navigator.vibrate` requires sticky activation; a timer armed
   and left alone can expire in a context Brave treats as not activated
   (shields/restriction), and the fire attempt silently no-ops.
3. **Background throttling delays detection.** The host's 1 s `setInterval`
   is throttled (≥1/min) or frozen in a backgrounded tab: a cook with the
   phone face-down hears/feels nothing at the deadline; whatever fires,
   fires only when the tab wakes — and then only the static banner shows.
4. **There is no channel that cannot fail.** Both existing channels are
   capability- or permission-gated; the alarm's guarantee therefore has no
   floor. The visual surface today (static banner text) does not satisfy
   "the timer must visibly demand attention".

## Decision

1. **The alarm is a THREE-channel engine: sound, vibration, visual.** The
   visual channel is a SHAKE: a repeating shake animation on (a) the app
   shell's global stop banner and (b) the alarming timer's own chip/card on
   the cooking strip, driven by the existing `alarmingTimers` reactive
   mirror — no new polling, no new store. The visual channel has NO
   settings toggle and CANNOT be off: it is the channel that cannot fail,
   the floor that makes the alarm honest. ADR-0093's both-channels-dead
   guard (`channelsLive`) is re-scoped: with the visual channel always
   live, an alarm always enters (and stays in) the alarming set, and the
   toggle-flip-is-a-user-stop rule now applies only to sound/vibration.
2. **The chime attempts recovery at fire time.** At each round, before
   playing, the engine attempts `ctx.resume()` when the context is not
   `running` and plays if the state reaches `running`; a context that is
   still not runnable degrades to the other channels as before — silently,
   but never as the alarm's only path.
3. **Vibration fires per its own toggle exactly as ADR-0093 specified**
   (feature-detected, live-read); no engine change beyond the channel
   split. Brave's activation gating is environmental; the fix for the user
   is the visual floor, not an API workaround.
4. **The host reacts to tab visibility.** On `visibilitychange` → visible,
   the host runs one tick immediately instead of waiting up to a throttled
   minute: returning to the app fires the alarm (round 1 or the next due
   round) at once, with the shake making it unmissable.
5. **No new dependency, no new persisted key.** Shake is CSS keyframes on
   existing components; the channels stay governed by the existing
   `ui.timerAlertSound` / `ui.timerAlertVibrate` toggles.

### Decision log (coding-philosophy: DRY > SOLID > KISS)

- **DRY** — the visual channel rides `alarmingTimers`, the reactive mirror
  ADR-0093 already maintains for the banner; a separate visual-alarm state
  machine would duplicate the alarming set and drift from it.
- **KISS over configurability** — no third toggle for the visual channel:
  a toggle on the cannot-fail channel would let a user configure an alarm
  with no floor again, recreating this bug report as a settings state.
- **KISS over wake-lock** — a Screen Wake Lock while timers run would keep
  the tab alive when the phone sleeps but costs battery and adds a
  permission surface; rejected for now (recorded as the alternative). The
  visibility-tick gives the same "you are told the moment you look" floor
  without the cost.

## Consequences

- The cooking strip and the shell banner carry a shake animation gated on
  the timer being in the alarming set; e2e asserts the class/marker, not
  the animation timing.
- An alarm on a device where sound AND vibration are both unavailable now
  still rings VISIBLY and stops only by user action — the dead-alarm-loop
  guard never removes the alarming set entry for the visual floor.
- Brave users get round 1 the moment the tab is visible again even if the
  deadline passed while frozen; the escalating pause schedule is unchanged.
- `docs/agents/cooking.md`'s timer-alert section names three channels.

## Alternatives considered

- **Screen Wake Lock while any timer counts** — keeps the deadline firing
  on time with the screen off; rejected: battery cost + permission surface,
  and an offline SPA cannot beat a frozen tab anyway (see Decision log).
- **Notification API with a service worker** — would fire outside the tab
  entirely, but drags in a worker, a permission prompt, and a new dep
  surface; ADR-0102 owns the push/notifications domain — if device-local
  alarm reachability beyond the open tab is wanted, it goes there.
- **A third persisted toggle for the visual channel** — rejected (Decision
  log: recreates the no-floor alarm).
