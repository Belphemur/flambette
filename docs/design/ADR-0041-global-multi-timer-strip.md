# ADR-0041 · Global multi-timer strip + recipe-detected timer suggestions

**Status:** Accepted
**Date:** 2026-10-01
**Supersedes (placement only):** ADR-0038 step-timers-move-under-step-views
**Extends:** ADR-0020 (per-step timers), ADR-0010 (Meanwhile pairing is one view)

## Context

ADR-0038 moved the ADR-0020 timer controls INTO the step body. The owner
retested that shape while cooking and reversed it: while juggling an oven,
a pot of rice and a sauce, the timer controls must be reachable from ANY
step AND run CONCURRENTLY — a per-step single timer cannot represent
"oven 25 min + rice 12 min" live at once.

## Decision

1. **Placement: global strip again.** ONE horizontal strip docked in the
   cooking experience, above the step body / footer nav, visible from every
   view (the ADR-0020-era placement, restored). It keeps the measured
   h-11 hit targets. The ADR-0038 per-step `step-timer-row` is removed;
   ADR-0020's derive-from-`startedAt` countdown model persists untouched.

2. **Multiple concurrent named timers.** `stepTimer` becomes a LIST in the
   ui store: a timer carries `{ id: number, label: string, remaining:
   number, running: boolean, startedAt: number | null }` (label free-text,
   ≤24 chars, e.g. "Oven", "Rice"). Every timer starts independently; the
   strip renders one chip per timer simultaneously (countdown + label +
   pause + delete); taps open/continue that timer only. Adding a timer
   opens the preset ladder (ADR-0020's `TIMER_PRESETS_MIN` 1/3/5/10/15/20/30
   + custom minutes + first-view-only recipe-total) AND a name field that
   pre-fills from context (below). Limit 4 concurrent timers (screen
   space on Pixel 7); adding a 5th asks which to replace.

3. **Recipe-detected suggestion (build-time extraction).** Timer hints are
   extracted OFFLINE from the raw catalog by a stdlib Python script — the
   repo's existing generated-data pattern (`scripts/extract_ingredients.py`,
   `scripts/build_pack_index.py` in AGENTS.md). New
   `scripts/extract_timer_hints.py` scans all 2,730
   `public/data/recipes/*.json` step texts (incl. measured-amount-bearing
   lines) for an explicit cook duration ("Simmer the rice for 12 minutes",
   "Bake 20–25 min") and emits the COMMITTED artifact
   `public/data/timer_hints.json`: `{ [variantId]: [{ step: number,
   seconds: number, label?: string, range?: [number, number] }] }` —
   ranges record BOTH bounds; the UI suggests the lower bound and says so
   ("Bake 20 min (of 20–25)"; ADR-0022's no-fabrication rule holds: only
   authored durations are extracted). The runtime lib
   (`src/lib/timerSuggest.ts`) becomes a pure LOOKUP over the loaded
   artifact (per current view's steps, same `imageSrc`-style lazy pattern
   as the catalog load), NOT a runtime regex — offline behaviour is
   unchanged because the hints ship in the repo. Register the output in
   the AGENTS.md generated-data table; label with the food named in the
   sentence, else "Step N".

4. **Ambiguous anchors do NOT arm silently.** Tapping the suggested chip
   always lands in the confirm shape (name + minutes) with the proposal
   pre-filled — explicit user intent gates every arm/edge-case, no
   toast-surface countdown (ADR-0020's rule holds).

5. **Persistence & reload honesty.** The list is stored under the existing
   `ui.stepTimers[variantId]` key as `{ [timerId]: StepTimer … }` — the
   backup registry (ADR-0013) needs NO new slice. On reload, every running
   timer derives from its `startedAt` (never re-armed; an expired-timer
   dismissal confirms like the ADR-0020 finish flow).

6. **Leave-with-running-timers confirm** = every RUNNING timer asks before
   Finish/close (ADR-0020's confirm, generalised to a list).

## Consequences

- Positive: a cook juggling parallel jobs represents them all at once, from
  any step, with values authored by the recipe itself, not from memory.
- Neutral: single-timer flows stay one tap (the one chip reads the same).
- Accepting: the strip needs a scroll/shrink rule at 4 chips (grid shrinks
  the label of the least-recently-started chip first). Parser drift of the
  pure lib vs the authored text is tolerated — a missed suggestion NEVER
  invents a timer; a misparsed one is always user-confirmed before arming.
- e2e: `step-timer-row` hooks disappear; new hooks per chip
  (`data-test="timer-chip-*"`); the timed flows keep
  `step-timer`/`timer-preset-*`/`timer-clear` contracts (`step-timer` is
  the chip's countdown button; one per chip).
