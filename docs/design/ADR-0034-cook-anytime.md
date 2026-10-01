# ADR-0034: Cook any recipe, and remember which plan a cook came from

**Status:** Accepted (2026-10-01)
**Refines:** [ADR-0032](ADR-0032-cooked-history-shared-by-default.md) (the
`CookedEntry` shape that now travels the household) and the "cooking is a
plan-driven mode" note in `src/router.ts`.

## Context

Three things in the product are coupled today, and the coupling is the bug.

**1. `/cooking/:id` is gated on plan membership.** The route's `beforeEnter`
bounces any recipe that is not in the current plan back to the detail view,
on the stated reasoning that "cooking is a plan-driven mode". But the only
thing cooking actually needs from the plan is a *servings* number, and
`CookingView` already falls back to `meta.serving_count` when the recipe is
absent. So the gate buys nothing and costs the most obvious use case: you
find a recipe on the Recipes tab, tap **Start cooking**, and land back on the
detail sheet with no explanation. A deep link to `/cooking/17452` for a recipe
that was never planned is equally dead. The gate is also the reason the
e2e helper for cooking has to *add the recipe to the plan first* to test
cooking at all — the test scaffolding is compensating for the product rule.

**2. "Mark as cooked" exists only on the last step.** `CookingView`'s footer
carries `Previous` / `Next`, and on the last step a `Next`-replacement
**Finish** plus a second, separate **Mark as cooked** button. So the two
actions that mean the same thing (this cook is done) are presented as
different buttons, and the one that records history is hidden until the very
last step of a flow the user may be abandoning midway.

**3. A cook event does not say which plan it came from.** `CookedEntry` is
one row per cook event (`{variantId, cookedAt, id}`) and the read side
(`aggregateHistory` in `src/lib/history.ts`) groups purely by recipe, so the
History tab answers "what have I cooked" and cannot answer the question the
household actually asks when it reads the tab: *what was this batch, and when
was it put together?* With a plan a week old and ad-hoc cooks interleaved,
the flat list is not reconstructable after the fact — and it cannot be
reconstructed from the events, because the plan membership at cook time was
never recorded. Recovering it later would mean guessing from plan contents,
which `markCooked` has already mutated (it drops the meal from the plan).

So: ungate cooking, put "mark as cooked" where it can be used, and stamp the
plan identity onto the event at the moment it is written — because that is
the only moment the answer is knowable.

## Decision

### 1. `/cooking/:id` is ungated

The route's `beforeEnter` keeps only the id sanity check
(`Number.isFinite(id)`); the `planContains(id)` clause and the
`usePlanStore` import are removed, and the header comment is corrected.
Servings come from the plan entry when there is one and from the recipe's
own `serving_count` otherwise — no change needed in `CookingView`, which
already resolves exactly that.

### 2. The plan has an identity, persisted

The plan store gains two persisted members alongside `plan`:

- `planId: string` — a stable id for the CURRENT plan instance, minted when
  the plan transitions **empty → non-empty**;
- `planCreatedAt: number` — `Date.now()` at that same transition.

One transition mints one identity. Adding a second meal to a non-empty plan
keeps the identity (it is the same plan). Emptying the plan (cooking the last
meal out, removing it, `clearPlan`) invalidates the identity, so the next
meal added starts a NEW plan with a new id — which is the correct reading of
"what plan and when was it put together".

Persisted members that predate this ADR simply have no `planId`/
`planCreatedAt`; the store mints them lazily on first use rather than running
a migration, so a legacy install needs no write step to be consistent.

### 3. `CookedEntry` carries plan provenance

```ts
interface CookedEntry {
  variantId: number
  cookedAt: number
  id?: string
  planId?: string        // new, optional
  planCreatedAt?: number // new, optional
}
```

Both are OPTIONAL, which is the whole back-compat story: a row written by an
older peer (or an older backup) still validates, still merges, and renders
under an "earlier cooks" grouping. `planId` is the grouping key;
`planCreatedAt` is what the group header shows.

`markCooked(variantId, ctx?)` takes an optional provenance context and
returns the event it created. The store resolves the context itself when the
caller passes none:

- the recipe IS in the current plan → the current plan's `planId` /
  `planCreatedAt` (captured *before* the meal is removed from the plan);
- otherwise → a freshly minted **ad-hoc** id, and `planCreatedAt` = now.

The Plan-tab **Mark as cooked** button (an existing second entry point, and
one that always marks a meal that IS in the plan) therefore records the
current plan's identity for free.

### 4. An ad-hoc cook is its own one-recipe plan

Owner rule: a cook started without a plan is treated as if a plan had been
generated containing only that recipe. Concretely: the cooking session
captures its plan context ONCE, at cook start — the current plan's identity
if the recipe is planned, else a freshly minted ad-hoc identity — and passes
that same context to every `markCooked` the session makes. So a mid-step
mark and the final **Finish** of one ad-hoc session are two events of the
SAME one-recipe ad-hoc plan, while the next ad-hoc cook of the same recipe
starts a new plan. The ad-hoc identity is NEVER written into the store's own
`planId`: an ad-hoc cook must not silently adopt, or become, the household's
real plan.

### 5. One Finish button, mark-as-cooked available at any step

- **At any step up to the last**, the footer carries a
  **Mark as cooked** button, `data-test="mark-cooked"`. It runs the same
  `confirmTimerBeforeLeaving()` gate the Finish button runs today
  (ADR-0020), records the cook event, and **stays in cooking mode** — the
  user is marking the meal while still cooking it. Toast: "Marked as
  cooked", with an **Undo** action.
- **On the last step only**, the `Next` slot becomes **Finish**
  (`data-test="finish"`, `bg-primary`, PartyPopper icon). **Finish is one
  action**: it records the cook event AND drops the meal from the plan
  (`markCooked` already does both, so "the change is in the buttons, not the
  store"), then closes. The second **Mark as cooked** button is deleted, and
  it is NOT shown on the last step either: there Finish already IS the
  mark, and a second button offering the same action is the two-buttons-
  for-one-action problem this change exists to remove. Toast: "Enjoy!
  Marked as cooked", with an **Undo** action.
- The old `v-if="isLast"` **Mark as cooked** button (the second one) is
  deleted. Mid-cook marking is reachable from step 1 onward, which is where
  the new `data-test="mark-cooked"` lives.

Toast messages keep their old substrings ("Enjoy!", "Marked as cooked") so
the existing timer/cooking specs keep asserting the same thing they assert
today; the undo action is the new part.

### 6. Undo restores the exact prior state

Both toasts carry **Undo** (`data-test="cook-undo"`, 6s, following the
Auto-Plan toast pattern from `PlanTab.confirmAutoPlan`). The snapshot is
taken at press time, before `markCooked` mutates anything: the plan entry for
the recipe (or `null` if it was unplanned) with its servings, and the
`clearedIngredients` row for the variant. Undo re-adds the plan entry
verbatim, restores the cleared row, and drops the event via the new
`unmarkCooked(eventId)`. Undo of an ad-hoc cook (no plan entry to restore)
just removes the event.

### 7. History reads by plan

`aggregateHistory` keeps grouping purely by recipe — it is the per-recipe
summary, and the per-variant `history-row` / `history-count-*` /
`history-add-*` contracts stay exactly where they are. Plan provenance is a
NEW read-side view over the SAME events, in `src/lib/history.ts`:
`groupHistoryByPlan(events)` returns groups keyed by `planId` (rows without
one fall into a single "earlier cooks" group), sorted by `planCreatedAt` then
last cook, each carrying its recipes. `HistoryView` renders that grouping
around the existing per-recipe rows.

Storage is NOT multiplied: one event belongs to exactly ONE plan, and there
is no second table, no per-plan entry array, no snapshot of plan contents. A
plan's membership is recoverable from the plan itself; the events only carry
the identity.

### 8. Per-event detail where the user asks "when exactly"

`RecipeDetail` KEEPS its `Cooked N times · last <relative>` line, and gains an
expandable spoiler listing the individual cook events, newest first, each
row showing BOTH `formatRelative` and `formatAbsolute` (both already exist in
`src/lib/history.ts`). The count is the affordance; the spoiler is the
answer. This is the per-event surface the flat count line could never give.

### 9. Additive everywhere else

`SharedState.cookedHistory` is already optional/additive, and `snapshot()`
spreads each row, so new fields ride along with no `room.ts` change. The two
places that rebuild rows field-by-field MUST learn the new fields or they
silently drop provenance on import:

- `src/stores/plan.ts`: `replaceCookedHistory` and `mergeCookedHistory`;
- `src/lib/backup.ts`: the `cooked-history.json` slice's `read()` and
  `validate()` (which today names exactly `{variantId, cookedAt} + optional
  id` in its error string).

Both accept the new fields as optional and preserve them; a peer or backup
that lacks them is still valid, and absence still means "don't touch"
(ADR-0028), never a wipe.

## Consequences

- The Recipes tab is a complete entry point to cooking; the Plan tab is no
  longer a prerequisite, and the e2e cooking helper no longer has to plan
  first.
- A cook event recorded from a recipe that is in two places (planned, and
  also cooked ad-hoc) is attributed to the plan it was cooked under, which
  is the plan that existed at that moment — no ambiguity in practice,
  because the planned path is resolved by plan membership at press time.
- Cooked-history events are now plan-attributed, so the History tab can be
  read as a batch log. The read side stays derived (no duplicated storage),
  so a plan that is later edited does not rewrite history.
- ADR-0032's union-merge still holds; `mergeCookedHistory` and the room
  reconciliation are unchanged apart from carrying two more fields.
- The plan store's persisted shape grows by two members, so the backup
  registry's plan slice must round-trip them (`STORE_SLICES`, ADR-0013).

## Alternatives considered

- **Keep the gate, add a "cook without planning" affordance.** Rejected: two
  ways into the same mode, and the deep link stays dead. The gate had no
  behaviour behind it (servings already fall back).
- **Store a whole plan snapshot per cook event.** Rejected: storage
  multiplication, a second source of truth for plan contents, and it would
  need its own merge rule against a live plan. An identity + creation time
  answers the question without duplicating anything.
- **Have ad-hoc cooks join the household's real plan.** Rejected: an ad-hoc
  cook would adopt the plan's identity and be filed under a plan the user
  never assembled, and the plan would gain a meal the user did not add.
- **Record the plan identity on the plan entries instead of the events.**
  Rejected: `markCooked` removes the meal from the plan, so the identity
  would be gone by the time the event is written. Provenance has to be
  captured at the moment of the cook.
- **Make Finish not mark cooked, keeping two buttons on the last step.**
  Rejected by the owner: one action, one button — "Finish records the cook
  and takes the meal off the plan".
- **Mid-cook mark closes cooking mode.** Rejected: the user is marking the
  meal and still cooking it; closing would be a second, hidden Finish.
- **A new ADR for the ungate alone.** Rejected: the three changes are one
  decision (cook any recipe ⇒ mark it where you are ⇒ remember what it was
  part of) and splitting them would produce two records arguing with each
  other.
