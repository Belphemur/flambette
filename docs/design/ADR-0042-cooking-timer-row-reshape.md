# ADR-0042 — cooking timer add-row reshape (layout/UX only)

* Extends: ADR-0041 (global timer strip + §4 auto-open pre-fill)
* Status: **Proposed**
* Companions: `src/components/CookingView.vue`, `e2e/cooking-timers.spec.ts`

## Context
The §4 auto-open opens a collapsible "add a timer" ladder (a `timer-add`
button → an expanded `timer-panel` containing a suggestion chip above the
name/minutes inputs, the input row, a preset chip row, and a Start/Cancel
row). Staged on mobile this is a tall vertical tower that the owner flagged
as "more about setting the timer than the timer running": the existing live
ux (see screenshot `Screenshot_20261001-175821.png`) is a **single horizontal
row** — existing-timer strip · name input · minutes input · preset chips ·
Start · X — and is what the reshape targets. The timer *engine* and the
§4 per-type gate are not in question; only the surface layout changes.

## Decision
Collapse the add surface to one horizontal row docked above the footer,
always visible when a recipe is open, so setting a timer needs no disclosure:
1. Drop the `timer-add` button and the `addOpen` disclosure entirely. The
   recipe suggestion (when §4 fires) is **pre-fill only** — it writes the
   name/minutes inputs, never arms.
2. The row, inside `data-test="timer-strip"`: `[timer chips] · name input
   (timer-name) · minutes input (timer-minutes) · preset chips (timer-preset-*)
   · Start (timer-confirm) · X (timer-cancel)`. Preset row scrolls
   (`overflow-x-auto`) when armed chips + inputs fill the width.
3. The §4 auto-open watch(suggestion) reduces to `applySuggestion(s)`
   (field pre-fill); remove the `addOpen.value = true` line. `watch(viewKey)`
   keeps clearing `nameInput`/`minutesInput`/`pendingArm` (LTW draft guard)
   but drops the `addOpen.value = false` line.
4. Under the 4-timer cap: render the "Replace which one?" prompt inline as a
   small chip strip (`timer-replace-${id}`) inside the row — no separate
   panel, one tap still swaps (pendingArm holds the refused label/seconds).
5. Add one new affordance absent from baseline: a floating manage button
   (`timer-fab`, lucide `List`, `aria-label="Manage timers"`) that opens a
   minimal bottom sheet listing armed timers with Pause/Restart/Clear. This
   is discoverability only — the chips themselves keep their inline buttons.
6. Constants `TIMER_PRESETS_MIN = [1,3,5,10,15,20,30]` and `MAX_TIMER_LABEL`
   (and the 15 extractor goldens) are **unchanged** — the preset set already
   matches the screenshot; no durations are added or invented.

### Hard NOs
- No radial/circular progress (that is "the timer running", out of scope).
- No changes to `stepTimer.ts`, `timerSuggest.ts`, `ui.ts`, sidecars,
  DESIGN.md, or `palette.ts`.
- The §4 per-type gate is untouched; a running "Oven" still does not
  suppress a "Rice" suggestion.

## Consequences
- `data-test` additions: `timer-fab`, `timer-manage-sheet`. Removals:
  `timer-panel` disclosure, `timer-add` toggle. Update
  `e2e/cooking-timers.spec.ts`: assert `timer-name`/`timer-minutes` are
  always in the DOM and pre-filled on suggestion; Start arms without a
  `timer-add` tap.
- Taller on mobile while the row is open vs the collapsed-then-tap flow,
  but one fewer step; the FAB keeps armed-timer management reachable from
  any step.
- Layout tested only where CookingView mounts; the strip is `fixed`-rooted
  above the footer, independent of step scroll.
