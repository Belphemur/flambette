# ADR-0042 — cooking timer add-row reshape (layout/UX only)

* Extends: ADR-0041 (global timer strip + §4 auto-open pre-fill)
* Status: **Accepted** (as built — see the two as-built notes in Consequences)
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
- `data-test` additions: `timer-add-row`, `timer-presets`, `timer-fab`,
  `timer-manage-sheet`, `timer-manage-scrim`, `timer-manage-close`,
  `timer-manage-row`, `timer-manage-toggle-${id}`, `timer-manage-clear-${id}`.
  Removals: the `timer-panel` disclosure and the `timer-add` toggle;
  `timer-cancel` survives with new semantics (clear the draft, not close a
  panel). Update `e2e/cooking-timers.spec.ts`: `timer-name`/`timer-minutes`
  are always in the DOM and pre-filled on suggestion; Start arms with no
  prior tap.
- Taller on mobile while the row is open vs the collapsed-then-tap flow,
  but one fewer step; the manage button keeps armed-timer management
  reachable from any step.
- Layout tested only where CookingView mounts; the strip is `fixed`-rooted
  above the footer, independent of step scroll.

### As-built notes (two, both deliberately narrow)
1. **The suggestion chip is RETAINED, not deleted.** §4 pre-fills the row
   when the gate allows, and the chip then has nothing to add — so it
   renders only while a field is still empty (`suggestionOffered`). That
   is the case the §4 per-TYPE gate REFUSES (a timer of the same type is
   live), where ADR-0041 §3's "the recipe offers a duration" promise would
   otherwise vanish with no way to ask for a second pot of rice. The §4
   e2e cases assert the pre-fill is the affordance (chip absent); the
   refused case asserts the chip is there.
2. **The manage button is docked in the strip's chip row, not a free
   overlay.** It sits outside the horizontally scrolling chip container so
   it can never scroll away, and being in flow it cannot overlap a chip
   or the footer on a Pixel 7. The z-index/placement problem of a `fixed`
   pill above a strip of unknown height is a worse trade than the
   "floating" look; the affordance and the `List` icon are as specified.

