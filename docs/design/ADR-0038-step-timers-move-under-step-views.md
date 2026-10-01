# ADR-0038: Step timers live on the step, not in a global strip

**Status:** Proposed (2026-10-01)
**Extends:** [ADR-0020](ADR-0020-per-step-timers.md) — its decision "one
timer per step VIEW" stands; what changes is presentation only.
**Companion ADRs:** ADR-0039 and ADR-0040, same change.

## Context

ADR-0020 shipped per-step timers as a persistent bar pinned above the
navigation footer (`CookingView.vue`, `data-test="step-timer-bar"`): on
EVERY step the user sees the countdown button (when armed), the preset
ladder, and — first view only — the recipe-total chip.

Two real problems with that presentation:

1. **The timer is not visibly linked to its step.** The strip reads as
   a global control ("the bar with the timer"), not "step 4's timer".
   The store model already keys by view (`viewKey`), but the UI never
   shows which step a countdown belongs to.
2. **The persistent bar costs ~60px of step-text space on every step**,
   for controls the user needs on maybe two steps of a long recipe.

The ADR-0020 countdown state model is NOT negotiable here —
`{remaining, running, startedAt}` derived from `startedAt`, persisted in
`ui.stepTimers[variantId][viewKey]`, minute-boundary live-region
announcements, the leave-with-running-timer confirm
(`confirmTimerBeforeLeaving`), the once-per-recipe "N m total"
suggestion — all stay as-is. What changes is WHERE the controls render.

## Decision

1. **The timer controls render under the step view they belong to.**
   The global bar (`step-timer-bar`) is removed from the footer area.
   Each step view gets a timer row under its content — below the step
   text and below the ADR-0022 measured-amounts disclosure — keyed by
   that view's `viewKey`.

2. **Per-step visibility.** A step WITH a timer renders its countdown
   button, presets and clear in that row. A step WITHOUT one renders a
   subdued "Add timer" row in the same position, which reveals the
   preset ladder (1/3/5/10/15/20/30 min chips; the "Nm total"
   recipe-total chip stays first-view-only). Navigating to another step
   view shows only that view's timer state. Timers keep counting while
   off-screen (a running timer survives navigation per ADR-0020; the
   `remaining − (now − startedAt)` derivation means an off-screen timer
   stays honest with zero rendering beyond the one on-screen row).

3. **Semantics unchanged** — presets one-tap start; the countdown
   button toggles play/pause and offers restart at 0:00; clear drops a
   view's timer; the leave-cook confirm (`Finish` / `Mark as cooked` /
   Escape / header close) still asks before killing a running timer on
   ANY view of the recipe; wake lock, polite live region on minute
   boundaries and the aria-label countdown contract are untouched. The
   timer is still device-local, never room-synced.

4. **e2e transition:** the `step-timer-bar` container hook is deleted
   and its assertions move to the per-step row
   (`data-test="step-timer-row"`), with the countdown button keeping
   `data-test="step-timer"` and its aria-label contract ("Pause timer,
   4:59 left"). The running-timer-survives-navigation/reload test keeps
   its behaviour: navigating away from an armed step shows THAT view's
   empty row and returning shows the countdown honestly derived from
   `startedAt`.

5. **Scope:** only `CookingView.vue` and `e2e/cooking-timers.spec.ts`
   (plus any spec pinning the bar's location). No store / lib / backup
   change; timers survive a reload exactly as before.

## Alternatives considered

- **Keep the global bar and label it ("Timer for step 4")**. Rejected:
  it keeps the per-step screen-space cost the owner asked to remove,
  and a global bar with per-step labelling adds a step to many glances.
- **A pinned floating timer chip while paging** (a mini countdown that
  follows navigation). Rejected for now: it re-introduces a persistent
  surface on every step, exactly what this ADR removes. If the owner
  later misses a glanceable countdown while paging, a corner-bubble
  overlay is a separate visual decision, not a store-model one.
- **Per-raw-step timers** (drop the ADR-0010 pair model): no. ADR-0020's
  one-timer-per-VIEW rule is load-bearing for Meanwhile pairs; this ADR
  only moves the controls.

## Consequences

- ADR-0020's state model and its countdown-button e2e contract survive
  untouched; only the container hook and the row's location change.
- A cook who wants to see a running timer navigates to that step — the
  honest cost of per-step visibility, accepted here.
- The e2e suite's `step-timer-bar` assertions are re-targeted, not
  weakened (same behaviours, new per-step hooks).
- The store, backup slice, relay payload and sanitizers are untouched
  (no `STORE_SLICES` change — the slice already exists).
