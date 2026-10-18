# ADR-0093: Timer alarm — recurring escalating alert with per-timer pitch

Status: accepted (2026-10-18)

Amends the "Timer alerts" section of ADR-0081 (cooking-mode composition):
the one-shot completion alert is revised into a RECURRING, ESCALATING
alarm. ADR-0081's other decisions (device-local settings, autoplay
discipline, the polite live region, the two toggles) stand unchanged.

## Context

The owner reports (2026-10-18), after cooking with ADR-0081's alerts on
Firefox mobile:

1. **Vibration never fires on Firefox.** Verified against primary
   sources, this is the browser, not the app: Mozilla disabled the
   Vibration API in Firefox 79 (July 2020) — `navigator.vibrate` stayed
   exposed but never vibrated (Bugzilla 1653318) — and REMOVED
   `Navigator.vibrate()` entirely in Firefox 129 (Bugzilla 1900037;
   MDN Firefox 129 release notes), partly so feature detection stops
   lying. All iOS browsers (WKWebView) never exposed it. No web-page
   workaround exists; Chrome/Samsung Internet still support the API.
   Pre-removal Firefox also required sticky user activation, which the
   Start-timer gesture already satisfies.
2. **A single chime is too easy to miss.** Hands in the sink, an oven
   roaring, or the phone face-down: one two-tone chime must be heard the
   exact second it fires. The alert must REPEAT until the user stops the
   timer — and the vibration must recur too, with the pauses between
   rounds GROWING (owner steering, same day), so an unattended phone
   escalates instead of buzzing nonstop.
3. **Every alarm sounds identical.** With ADR-0041's concurrent named
   timers, the oven and the rice expire to the same two tones — the cook
   cannot tell WHICH work finished by ear.

The Web Audio context is already unlocked inside the Start-timer gesture
(ADR-0081 autoplay discipline), so a repeating chime needs no new
permission surface; `navigator.vibrate` re-fires freely where it exists.

## Decision

1. **Recurring escalating alarm (the host owns it).** When a timer THIS
   session watched count down reaches zero, the device-level host
   (`src/lib/timerAlertHost.ts`) alerts in ROUNDS: each round is the
   chime + the vibration pattern (each channel honoring its toggle,
   read live as today), and the pause AFTER a round grows round over
   round — 2 s, 4 s, 8 s, 16 s, then a 30 s cap. The alarm repeats
   UNTIL THE USER STOPS THE TIMER: every verb the card and chip already
   carry is a stop — Restart/Resume re-arms (the countdown is live
   again), Pause freezes, Cancel/Clear removes the timer. NO new
   control is added: adding a separate "silence" button would give the
   alarm a state the timer does not have. A timer already expired when
   the session first saw it stays silent (ADR-0081's seeding rule is
   untouched). Finishing the cook does NOT silence an alarm — the
   owner's rule is explicit: only the user stopping the timer stops it.
2. **Per-timer pitch.** The chime is transposed by the timer's ORDINAL
   among its recipe's timers (the strip's order, oldest id first):
   semitone offsets 0, +2, +4, +7 for timers 1–4 (bounded by
   `MAX_CONCURRENT_TIMERS`), every tone of the A5→D6 pair shifted so
   the interval is preserved. The host derives the ordinal from the
   sorted id list at fire time; the engine takes it as an argument.
3. **Honest vibration capability in Settings.** Where `navigator.vibrate`
   is absent (Firefox ≥ 129, every iOS browser), the Settings Vibration
   row says this browser cannot vibrate and the toggle is disabled in
   place (the stored preference is kept — a device that later runs a
   capable browser keeps its choice). The engine's graceful no-op is
   unchanged; we never fake vibration. Sound keeps carrying the alarm.
4. **Invariants kept:** device-local, never room-synced; no new runtime
   dependency; no audio asset; the ONE host interval stays the
   scheduler (each 1 s tick checks which rounds are due — no per-round
   timers to leak); a page hidden long enough to suspend the Audio
   context degrades the chime silently, as today.

## Consequences

- An ignored expired timer now rings on a 2→30 s backoff indefinitely
  until the user acts — deliberate: food being done is not a notification
  to dismiss later, and the owner asked for exactly this stop rule.
- The host's stop conditions gain the alarming set: the 1 s loop keeps
  running while any timer is alarming, even though nothing is counting.
- Unit tests drive the round scheduler with controlled clocks (rounds,
  growing pauses, stop-on-user-action) and the pitch with injected
  factories; Playwright still cannot hear or vibrate, so the only new
  e2e-visible surface is the Settings capability note.
- Firefox users get a Settings row that tells the truth instead of a
  toggle that silently does nothing.

## Alternatives considered

- **Web Notifications with a `vibrate` option** (service-worker
  `showNotification`): needs a permission prompt and a service worker,
  and Firefox's support for the vibration option is exactly the API it
  unshipped — rejected for this round.
- **Fixed-interval repetition** (no growth): nonstop identical buzzing
  is worse than escalating; the owner asked for growth.
- **Distinct melodies per ordinal**: harder to keep "slightly
  different", and a transposed interval is trivially unit-testable.
