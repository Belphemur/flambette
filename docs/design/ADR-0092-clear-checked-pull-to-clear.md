# ADR-0092: Clear-checked removes only checked items; pull-to-clear gesture

- **Status:** accepted (2026-10-18) — implemented in PR #94
- **Date:** 2026-10-18
- **Decides:** the semantics of clearing only the checked items, the
  pull-to-clear gesture, and the single adaptive clear button
- **Extends:** ADR-0005 (clear removes until cooked) — it does not
  supersede it; "Clear list" keeps its ADR-0005 semantics

## Context

ADR-0005 shipped "Clear list" as all-or-nothing: it snapshots every
planned meal's ingredients into `clearedIngredients` and removes them
all, behind a confirm modal. In the original Mealime mobile app,
clearing was a pull-down gesture on the list that removed only what the
shopper had already checked off, keeping unchecked items visible. The
owner wants that pattern back, plus a button equivalent, with parity
between the Grocery tab and Shopping view. (The food-themed confetti
celebration when everything is checked is a separate future record —
explicitly out of scope here.)

## Decision

**1. One adaptive button in the sticky progress card, on both Grocery
and Shopping views.** The button is visible whenever the list has items
(not only when something is checked, as today), and its label + action
follow the checked state:

- `checkedCount > 0` → label **"Clear checked"**. The action removes
  ONLY the checked lines: checked custom items are removed from
  `customItems` (their checked keys forgotten, autocomplete memory in
  `customIngredients` survives), and the checked recipe-derived
  nameKeys are **merged** into `clearedIngredients[variantId]` for
  every meal that uses them — merged, not replacing an existing
  cleared set. The checkbox map is then wiped. NO confirm modal: the
  action is direct and reports via a status toast. Unchecked items
  remain on the list, still unchecked.
- `checkedCount === 0` (list non-empty) → label **"Clear list"**,
  existing behavior unchanged: confirm modal, then the ADR-0005
  clear-everything snapshot.

Note the existing `confirmAndClearGrocery` guard no-ops when nothing
is checked; the "Clear list" branch must bypass that guard — when the
button reads "Clear list" it must actually clear.

**2. Pull-to-clear gesture (touch devices).** While the list is
scrolled to the top and at least one item is checked, dragging down
visually translates the content with the finger (pull-to-refresh
feel, with resistance) and shows a state indicator — "pull" while
below threshold, "release to clear checked" once armed. Releasing
past the threshold performs the same clear-checked action as the
button. Releasing below the threshold animates back and does
NOTHING. The gesture must not fight native scrolling (it activates
only at scrollTop 0, and must not break overscroll/touch-action
behavior). Desktop is unaffected; the button is its affordance.

**3. Removal lifecycle is ADR-0005's:** cleared ingredients stay
hidden until the meal is re-planned or marked cooked. `clearedIngredients`
remains household state riding the room payload (`cleared` field), so
a pull-to-clear on one device removes the checked items for the whole
room.

**4. Both views call one shared implementation** (the grocery lib /
composable), never duplicated view logic — same rule as ADR-0003's
"views must never duplicate aggregation logic".

## Consequences

- The `plan` store needs a merge primitive for `clearedIngredients`
  (`clearIngredientsForCurrentMeals` REPLACES each variant's set; the
  merge must add to what is already there).
- The all-checked auto-prompt modal stays as is.
- The progress-card layout must absorb the always-visible button
  without crowding the count/percent on the 82px-wide mobile tab row's
  sibling — keep the button compact and pinned by e2e.
- e2e coverage is mandatory on Desktop Chrome + Pixel 7: label
  switching with the checked state, clear-checked semantics (checked
  gone, unchecked remain, cleared hidden after), the "Clear list"
  branch with zero checked items actually clearing, and the gesture
  (drag past threshold clears; short drag cancels).

## Alternatives considered

- **Two buttons side by side** ("Clear checked" + "Clear list") —
  rejected: the sticky progress card is too cramped on mobile.
- **Confirm modal on Clear-checked** — rejected by the owner: it only
  removes items the shopper already ticked off; unchecked items are
  preserved.
- **Uncheck-only clear (wipe the map without hiding)** — rejected: the
  list is derived, so the cleared lines would instantly rebuild
  (the exact ADR-0005 bug class).
- **Gesture without a button** — rejected: desktop and accessibility
  need a visible affordance; the gesture is additive on touch devices.
