# ADR-0046 — Auto-Plan dialog as a component, on the shared dropdown, and
# the post-sync algorithm review

* Extends: ADR-0045 (one shared `FilterDropdown`), ADR-0043 (the meal-type
  taxonomy + counts artifact), ADR-0027/0031/0033 (Auto-Plan v2, household
  preference, regenerate seed), ADR-0037 (remembered default servings)
* Status: **Proposed** (2026-10-02)
* Companions: `src/components/AutoPlanDialog.vue` (new),
  `src/components/PlanTab.vue` (shrinks), `src/lib/mealTypeFilter.ts`
  (taxonomy source), `src/lib/packPlanner.ts` + `src/composables/useAutoPlan.ts`
  (reviewed, unchanged arithmetic), `e2e/auto-plan.spec.ts`

## Context

Owner, verbatim: *"Autoplan feature needs to be updated and using the right
drop downs too"*, *"also apply /coding-philosophy so it should be own
component too and we need to review the algo again"*, *"we can interrupt pi
and give it a new ADR to continue the work"*.

Three findings drove this ADR, in the order the coding-philosophy skill
orders them (DRY > SOLID > KISS):

1. **The Auto-Plan dialog is a ~350-line inline block inside an 828-line
   `PlanTab.vue`** — its own state (`pendingPlan`, `autoPlanCount`,
   `autoPlanCategory`, `autoPlanBusy`), its own `watch` invalidating the
   confirmable pack, generate/confirm/undo handlers, and the whole markup.
   The dialog is ONE behaviour with ONE state machine living inside a
   component whose main job is the plan list.
2. **Its two dropdowns are native `<select>`s** (`auto-plan-ruleset`,
   `auto-plan-category`) — the exact inconsistency ADR-0045 just eliminated
   from the Recipes tab. ADR-0045 built the reusable dropdown; leaving two
   `<select>`s here would make FilterDropdown "the Recipes-tab dropdown"
   instead of THE dropdown.
3. **The Meal-type options are stale against the taxonomy ADR-0043 froze.**
   The dialog offers Dinner / Breakfast / Dessert / Any, hard-coded in
   `PlanTab.vue`; the catalog carries six ruleset values and the Recipes
   dropdown now offers five occasions + Any with build-time counts. Lunch
   (304 recipes, the `simple` ruleset) and Snack (89) are unreachable from
   Auto-Plan. A second hand-written copy of the taxonomy is a DRY failure —
   and this one has already drifted.

## Part 1 — algorithm review (packPlanner.ts + useAutoPlan.ts)

Reviewed line-by-line after the catalog sync (2,759 recipes) and the
re-pin. Verdict first: **the greedy packer is correct and no arithmetic
changes.** The e2e pin `[17452, 9889, 6389, 6167]` holds because the default
ruleset stays `dinner` and the scoring is untouched. Findings:

### Kept as designed (documented, not fixed)

- **K1 — Zero-inclusive smoothing mean.** `smoothedRating`'s prior mean is
  the plain average of `rating` over the eligible slice, counting unrated
  recipes as 0 rather than averaging over rated recipes only. Within a
  slice all candidates compete under the same mean, so ranking is
  internally consistent; a rated-only mean would compress rating
  differences toward the mean (everything converges to it) and CHANGE the
  pack arithmetic — breaking the v2 bit-for-bit contract the e2e pin
  guards. Kept deliberately; flagged so the next reader does not "fix" it.
- **K2 — Per-row ceil for scaled base meals** (`commit()` factor path):
  ceil per container row then summing is ≥ ceil of the sum when a recipe
  carries two rows for the same (ingredient, container). Conservative
  (over-buys by at most one container in a corner case), matches ADR-0017's
  purchase-line reading, and is parity-gated by `data:verify`. Kept.
- **K3 — Pack previews are computed at authored servings (6), while new
  meals land at the household's default servings (ADR-0037).** The preview's
  `packagesBought` is an estimate at the authored scale by design ("index
  amounts are at the authored servings and scale at read time"); the plan
  entries then scale at read time. Documented; not a defect.

### Verified correct (no action)

- Determinism: same (index, request) → same pack; ties resolve
  rating-desc then lower-id; `candidates` ascending-id + stable sort makes
  the seed rank order well-defined; the `gen % k` seed guard degrades
  non-finite/negative generations to 0 (hostile backup import).
- Exclusion soundness: the eligible set's complement is ALWAYS excluded
  (`excludeIds`), even when eligible is empty — a missing `excludeIds`
  would mean "exclude nothing" (qodo round 1 closed this).
- ADD/REPLACE: base meals pre-commit and are never re-picked; REPLACE
  excludes planned meals instead; `baseServings` ceil-scales container rows.
- Household preference (ADR-0031): `FAVORITE_BONUS` is a tie-nudge; the
  seed ranking is deliberately NOT favourite-biased.
- `containerKeyId` packing (`keyId * 1024 + unitId`) is safe at current
  interning sizes (338 keys, 53 units).

## Part 2 — the decisions

### 2.1 Extract `src/components/AutoPlanDialog.vue` (KISS: one behaviour, one home)

The dialog moves wholesale — state (`autoPlanOpen`, `autoPlanCount`,
`autoPlanCategory`, `autoPlanBusy`, `pendingPlan`), the
changed-settings-invalidate-preview `watch`, generate/confirm/undo, and the
markup — into `AutoPlanDialog.vue`. `PlanTab.vue` keeps the trigger button
and renders the dialog. A pure move, no behaviour change: the ADR-0033
generation rules (advance on apply AND at press-start when a preview is
pending) move WITH the handlers that implement them, and the data-test
contract (`auto-plan-*`) is preserved verbatim.

### 2.2 Both selects become `FilterDropdown` (DRY: one dropdown, consumed)

- **Meal type** (`auto-plan-ruleset`): options come from
  `src/lib/mealTypeFilter.ts`'s exports (`OFFERED_MEAL_TYPES` +
  `mealTypeLabel`), NOT a second hard-coded list — the taxonomy lives once.
  Five occasions + Any, each with its build-time count, the occasion icon
  rendered through `<HueIcon :role>` with `mealRole` (same rendering as the
  Recipes dropdown, ADR-0043 addendum). Option ids are the ruleset values
  (`simple` stays `simple` under the hood, surfaced as **Lunch**).
- **Protein** (`auto-plan-category`): Any protein / Meat / Fish /
  Vegetarian, icons through the protein roles (`proteinRole`) so the dialog
  speaks the same colour language as the Recipes protein chip.
- **The Mode segmented control stays a radio group** — a 2-choice toggle is
  not a dropdown; forcing it into FilterDropdown would be KISS loss, not
  DRY gain.
- `FilterDropdown` may need a small generalisation (e.g. an optional
  dense/inline variant for the sheet's `justify-between` rows, or the label
  moving to the trigger's `aria-label`). Generalise the ONE component; do
  not fork a second one. Any prop added must keep the three Recipes-tab
  call sites byte-identical in rendered output.

### 2.3 Type widening, store untouched

`AutoPlanRulesetFilter` widens to include the five occasions
(`'dinner' | 'breakfast' | 'dessert' | 'simple' | 'snack' | 'any'`), reusing
`MealTypeId` from `mealTypeFilter` where the unions meet. The persisted
`ui.autoPlanRuleset` (default `'dinner'`) keeps its shape; a stored
out-of-list value must normalize to `'any'`… no — to `'dinner'`, the
documented default, on read. No STORE_SLICES change, no payload change, no
migration: the value is a string either way.

### 2.4 e2e

- `auto-plan.spec.ts` uses `selectOption(...)` on the two selects — native
  `<select>` interaction. Rewrite those call sites to the listbox
  interaction (click trigger, click option by its `data-test`), keeping the
  selectors `auto-plan-ruleset` / `auto-plan-category` and option ids
  `auto-plan-option-<value>`.
- New coverage: Lunch and Snack appear as options with their counts; picking
  Lunch yields only `ruleset === 'simple'` meals (the label↔ruleset mapping
  is the thing that must not silently flip).
- The default dinner pin `[17452, 9889, 6389, 6167]` must still pass
  unchanged — it is the guard that this refactor is presentation-only.
- `probe_autoplan_pin.ts` is unaffected (mirrors the lib, not the UI).

## Consequences

- `PlanTab.vue` drops ~350 lines; the Auto-Plan behaviour is reviewable in
  one file.
- FilterDropdown has five call sites (three Recipes + two Auto-Plan) — a
  real reusable component rather than a one-page extraction.
- Lunch/Snack become plannable occasions; the taxonomy has exactly one
  source (`mealTypeFilter` over `recipe_types.json`).
- No planner arithmetic changed; the pin is the regression gate.

## Decision log

- 2026-10-02 — extracted the dialog instead of leaving it inline: the
  owner named the component boundary explicitly, and the state machine
  (preview-invalidation watch, ADR-0033 generation rules) is cohesive
  enough that the extraction is a move, not a redesign.
- 2026-10-02 — taxonomy unified onto `mealTypeFilter` rather than extending
  the local `RULESETS` list: the local list is the copy that already
  drifted (missing Lunch/Snack), which is the exact failure DRY exists to
  prevent.
- 2026-10-02 — algorithm review closed with zero arithmetic changes; K1–K3
  documented as deliberate so they are not "fixed" into pin-breaking
  "improvements" later.