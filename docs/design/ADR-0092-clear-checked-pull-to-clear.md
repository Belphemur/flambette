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

## Change note — 2026-10-18, review round 1 (PR #94)

Three amendments from review + real-device testing; Status stays
`accepted`.

1. **Clear-checked is line-granular.** The original decision merged the
   checked keys' nameKey halves into `clearedIngredients[variantId]`,
   which hid EVERY line of an ingredient when the shopper checked only
   one of its sibling unit lines (`2 tbsp` vs `30 ml`) — contradicting
   this ADR's own "unchecked items remain". Amended: the snapshot the
   grocery engine registers now also carries the currently-rendered
   full line keys per group; a checked LINE key hides only that
   rendered line (`aggregateGroceries` filters rendered lines by full
   key), and the bare nameKey joins the whole-ingredient ledger only
   when every sibling line is checked. Both grammars share the one
   per-variant cleared set (bare nameKey vs `nameKey||basis`), so
   nothing new rides the room payload — a pre-#94 peer's nameKey-only
   skip rule is unaffected by entries containing `||`. A checked key
   the current render does not contain (stale residue from a servings
   change) is wiped with the checkbox map, never allowed to hide a
   current line. The toast counts distinct cleared lines, not
   per-variant snapshot rows.
2. **The gesture owns the touch while it is a candidate.** Real
   Firefox Mobile and Brave fired `pointercancel` from the native pan
   before `pointerup`, so the armed pull snapped back without clearing
   — invisible to the emulated Pixel 7 e2e, whose synthetic
   PointerEvents no scroller can cancel. The composable now listens
   `touchmove` non-passively on the region and `preventDefault()`s
   DOWNWARD travel while a touch armed at the top is pending or
   engaged; upward travel is left to the browser so the list still
   scrolls from its top. `overscroll-behavior-y: contain` moved from
   the (non-scrolling) region divs — where it was inert — to `html`,
   the actual scroll container, suppressing the browser's native
   pull-to-refresh. The arm check reads `document.scrollingElement`
   with a 4px tolerance (mobile visual-viewport offsets sit a few px
   off 0), a second finger is rejected while a pull is pending, and
   `pointercancel` only ends the pull when it names the active pointer.
3. **Shop view's adaptive button is guarded by `totalCount > 0`** like
   the Grocery tab's — an empty list no longer offers a "Clear list"
   modal that clears nothing.

## Change note — 2026-10-18, review round 2 (PR #94)

One amendment from kody's round-2 pass on the round-1 code; Status stays
`accepted`.

**Cleared line keys survive composition changes (unit-identity
matching).** Round 1 persisted the RENDER-summed basis
(`soy sauce||3 tbsp`) into every contributing variant's
`clearedIngredients`. That key was valid only for the plan composition
it was cleared under: cooking or unplanning ONE co-contributing meal
(`restoreIngredients` forgets only that variant's row) re-summed the
shared line to a different basis (`2 tbsp`), the persisted key stopped
matching, and the cleared line reappeared unchecked even though the
household never re-planned. Amended: `aggregateGroceries` now matches a
persisted full key against the current render by COMPOSITION-STABLE
unit identity — the nameKey plus the basis's unit (the normalized
container key `pkg|142 g` for container quantities, the trailing unit
token otherwise; `raw||`-namespace keys stay exact-match-only). The
unit survives composition changes, so the cleared line stays hidden
across co-contributor cooks/unplans and serving bumps, while the
sibling guarantee is structural: a by-unit line is unique per unit and
a container line unique per (noun, annotation) inside its group, so one
identity can hide at most the line it was cleared from and an unchecked
sibling line (a different unit) can never be swallowed. The persisted
structure is unchanged — same per-variant cleared set, same two
grammars, no new room payload field; ADR-0005's replace paths are
untouched.

The Contributing Meals card's line count now derives from the SAME
visibility (kody round 2, K2): a meal's row counts its group's
surviving rendered lines (`mealSurvivingLines`), so a partially cleared
two-line ingredient reports one line and the card tracks the list
line-for-line instead of filtering bare nameKeys only.
