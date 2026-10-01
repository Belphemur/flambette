# ADR-0037: A remembered default serving size

**Status:** Accepted (2026-10-01)
**Refines:** the servings defaults in `RecipeDetail`, `PlanTab`, `HistoryView`
and `CookingView`, and the servings half of `plan.addToPlan`'s signature.

## Context

Every one of the 2,730 recipes in the frozen catalog is authored
`serving_count = 6`. That is a **recipe** fact — it is how the author wrote
the quantities — and the app used it as a **household** fact, on four
surfaces at once:

- the recipe detail sheet seeded its stepper from `meta.serving_count`;
- `plan.addToPlan(meta, servings = meta.serving_count)` defaulted to it, so
  any caller that forgot to pass a count silently inherited 6;
- `HistoryView`'s re-plan button called `addToPlan(row.meta,
  row.meta.serving_count)` explicitly;
- `PlanTab.confirmAutoPlan` hardcoded `servings: 6` for every generated meal;
- and `CookingView` fell back to `meta.serving_count` for an unplanned cook.

So a household that cooks for four had to re-dial the same six-to-four
correction on **every recipe, on every surface, forever** — and worse, a
recipe that legitimately needs 12 (a batch cook, a party) left the default
permanently wrong in the other direction, because there was nowhere to say
"this is usually four".

There was no setting for it either. Settings (ADR-0016) carries the data
surface — household sync and backup — and nothing about portions, so the
number was not merely annoying, it was unreachable.

## Decision

### 1. One persisted `defaultServings` on the ui store

`ui.defaultServings: number`, persisted under the existing
`mealime-planner:v1:ui` key and added to that store's `pick` list. It starts
at `FALLBACK_SERVINGS = 6`, so **an install that never touches the control
behaves exactly as it did before** — which is also what keeps the pinned
e2e assertions (the Auto-Plan pack's `servings: 6`, the cooking-scale
helper's bump-from-6 loop) valid without touching them.

`src/lib/servings.ts` is the pure part: `clampServings`, `isServings`,
`MIN_SERVINGS = 1`, `MAX_SERVINGS = 99`, and the fallback. One clamp, shared
by the store, the components and the backup validator, so no surface can
invent its own bound.

### 2. Every deliberate servings change is remembered

Two writes, both through `ui.setDefaultServings`:

- the **recipe detail stepper** (`RecipeDetail.setServings` now routes both
  buttons through one function that writes the local ref AND the memory);
- the **plan row stepper** (`PlanTab.bumpServings`) — scaling a planned
  meal up for a big dinner is the clearest possible statement of "this is
  roughly how we cook".

plus the **Settings → Default servings** control, which is a direct view of
the same store value rather than a second independent setting.

The steppers write on **change**, not on open, and not on add-to-plan.
Opening a recipe must not silently redefine the household's default, and
adding a recipe at the default must not count as a change — otherwise
merely browsing the catalog would drift the number.

### 3. The remembered value is the starting point everywhere

- **Recipe detail** seeds `servings` from `ui.defaultServings` per load.
- **Auto-Plan** applies `ui.defaultServings` to every generated meal
  (replacing the hardcoded `6`).
- **History re-plan** adds at `ui.defaultServings`.
- **Cooking**, for a recipe with no plan entry, falls back to
  `ui.defaultServings`.

`plan.addToPlan`'s `servings` parameter is now **required**. That is the
part that stops this regressing: a defaulted parameter is how the authored 6
reached every add path in the first place, and a required one makes each
caller state which count it means.

### 4. Meals already in the plan do NOT move

The default is a **starting point for new work**, not a re-baselining of the
plan. A meal in the plan keeps the servings it was added with, and lowering
the default afterwards leaves it alone. Re-scaling an existing plan is a
decision the user makes per row, with the stepper that is right there.

### 5. Device-local, deliberately NOT household state

`defaultServings` is **not** in the room payload. The household's shared
truth about portions is the servings **on the plan entries**, which already
sync. A default is one person's starting point: syncing it would let a
phone that happens to be batch-cooking for eight re-open a recipe another
member had deliberately set to four. This is the same reasoning that keeps
`favOnly` local while the rest of `quickFilters` is household state
(ADR-0028).

### 6. Validated, clamped and repaired, because it is arithmetic

Unlike a UI label, this value multiplies into every recipe's scale factor, so
a bad one is not cosmetic:

- `setDefaultServings` **clamps**; a below-floor write (a `servings--` at 1
  sends 0) is **ignored** rather than stored, since storing it would re-scope
  every future recipe to a single portion.
- `repairDefaultServings` runs from the store's `afterHydrate`. Hydration is
  a raw `$patch` of localStorage, so a hand-edited or truncated blob lands
  verbatim; anything that is not a usable count becomes the fallback.
- `settings.json` carries it (ADR-0013 registry rule), with an
  **optional-on-read, strict-on-present** contract: a pre-ADR-0037 backup has
  no key, which validates fine and restores the authored 6 on write (the
  dialog promises settings are overwritten, so an absent modern key resets
  rather than leaving the device's value — the same rule the other modern
  keys follow), while a key that IS present must be a real count or the
  whole archive is rejected, because import is validation-first and atomic.

## Consequences

- Set the household size once (Settings, or by adjusting any recipe) and
  every later recipe, pack and re-plan starts there.
- The authored 6 stops being a user-visible constant. It survives only as
  the fallback, which is the correct place for a catalog fact.
- `plan.addToPlan` is now a two-argument call with no default; the four
  in-repo callers all pass an explicit count, and a fifth caller cannot
  reintroduce the bug by omission.
- The ui store's persisted shape grows by one member, so `settings.json`
  grows a key — handled here, in the same change, per the ADR-0013
  standing rule.
- Auto-Plan and History re-plan now produce household-scaled plans rather
  than authored-6 ones, which is the point; a user who WANTS the authored
  portions for a recipe sets that recipe's stepper before adding it.

## Alternatives considered

- **Make the servings stepper itself remember, with no setting.** Rejected:
  the user asked for it in Settings, and a control you can only reach by
  opening a recipe is not discoverable. Both exist; the setting is the same
  store value, not a copy.
- **Sync `defaultServings` with the room (household state).** Rejected: it
  would let one phone's cook silently re-open another member's recipes at a
  different size. The plan's servings already carry the shared truth.
- **Re-baseline the whole plan when the default changes.** Rejected: it
  would silently rescale meals the household already agreed on, with no
  undo and no per-row signal.
- **Seed the default from the most-cooked recipe's servings.** Rejected as
  inference the user did not ask for: it guesses, it is wrong on day one,
  and it makes a visible number move on its own. A remembered explicit
  choice is honest about its provenance.
- **Cap the remembered default at a realistic household size (say 12).**
  Rejected: 99 is a sanity bound against a corrupted value, not a product
  opinion. A 24-serving batch cook is a real thing.
- **A new bottom tab for it.** Rejected: ADR-0016's five-tab layout is
  e2e-pinned at Pixel 7 fit, and a preference belongs in Settings.
