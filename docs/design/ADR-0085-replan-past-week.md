# ADR-0085: "Cook that week again" — one-tap re-plan of a past week from cooked history

**Status:** Accepted (2026-10-13) — implemented in PR #87
**Implements:** Belphemur/flambette#78
**Extends:** ADR-0032 (cooked history), ADR-0034 (history grouped by plan),
ADR-0030 (preview before replace + exact-state undo), ADR-0037 (remembered
default servings).

> Numbering note: ADR-0084 (ConfirmModal) landed on main from PR #86
> between this record's drafting and its implementation; the numbers do
> not collide.

## Context

Issue #78 asks for the r/mealime shutdown pattern: users saved a plan per
week and "repeat the loop every six months". All the data already exists —
`plan.cookedHistory` (ADR-0032) records what was cooked and when, and the
History tab already renders it **grouped by the plan each cook belonged to**
(ADR-0034, `groupHistoryByPlan`), so every past week is one visible group
with its own header row. What is missing is the single action that turns a
past group back into the current plan.

Today the only path is per-meal: tap "Add to plan" on each card of the old
week (ADR-0037 already made that write at `ui.defaultServings`), N taps for
an N-meal week, with no notion of "this is THAT week again".

## Decision

### 1. The affordance is a per-group header action on the History tab

Each history group whose cooks belong to a plan (`group.planId !== null`)
gets one compact **outlined secondary pill** in its header row, right
aligned beside the relative-date label: a RefreshCw icon (15px) plus the
label **"Cook that week again"**.

- Outlined treatment (1.5px warm border, espresso label, transparent
  surface, hover/sunken fill) — the same grammar as the meal cards'
  "Add to plan" buttons. The tab's ONE filled intent stays the empty
  state's "Browse recipes" (ADR-0036/0072); this is a secondary action,
  not a page-level CTA.
- The **"Earlier cooks" group** (`planId === null`) gets NO affordance:
  those events have no plan to reconstruct. The per-card "Add to plan"
  remains the only path there.
- A group whose recipes have all left the catalog renders nothing today
  (ADR-0034's defensive filter) — it consequently carries no affordance.

Design authority: **Stitch project 2725470430841257407 (Warm Culinary
Paper)**, screens "Flambette — History (Re-plan Variant A - Inline Action)"
(desktop) and "Flambette — History (Re-plan Action: Inline Pill)" (mobile);
the adopted decision is Variant A's inline placement in the group header
row. The generated "Framed Pill/Strip" variants are recorded alternatives,
not adopted.

### 2. One tap opens the ADR-0030 preview — it never replaces silently

Tapping the pill reconstructs the group's meal set and renders the SAME
confirm grammar Auto-Plan established in ADR-0030, as a compact modal on the
AppModal machinery:

- one tile per meal with **image and title**, resolved through the
  in-memory catalog (`catalog.byId`) with `imageSrc`/`onImgError` — the
  exact helpers the history cards and plan rows already use, so the
  preview, the plan and the grid cannot disagree about a picture;
- a meals count and the replace warning line ("Replaces your current plan
  (N meals)");
- a confirm button and a "Keep editing" escape — confirm-before-destroy,
  unchanged from ADR-0030.

### 3. Confirm applies replace + exact-state undo — no new persistence

Confirming calls the existing `plan.replacePlan(entries)` with one entry
per distinct variantId of the group (deduplicated, catalog-present ones
only, in the group's most-recent-cook-first order), every meal at
`ui.defaultServings` (ADR-0037 — the same remembered count the per-card
button already writes). No stepper is offered: re-planning a past week at
its remembered household default is the one sensible count, exactly as the
history row's add already reasoned.

After the replace, the toast carries an **exact-state undo** built from a
snapshot taken at confirm time (plan entries + custom ingredients), the
same contract as Auto-Plan's undo — a room peer may have planned a meal
mid-preview; the undo restores the confirm-time state, not the preview-
time one. One confirmation at a time: the pill is inert while a preview is
open.

**No new persistence of any kind.** The group's meal set is derived on
demand from `cookedHistory` + `groupHistoryByPlan`; nothing is stored.

### 4. Hooks and coverage

- `data-test="history-replan-<planId>"` on the pill,
  `data-test="replan-preview"` on the modal block, `data-test="replan-
  confirm"` / `data-test="replan-cancel"` on the two actions.
- e2e: pill only on plan-backed groups (absent on "Earlier cooks"),
  preview tiles match the confirming plan, confirm replaces and undo
  restores. Unit: the reconstruction (dedupe, catalog filter, servings)
  is a pure function pinned in `src/lib`.

## Consequences

- Repeating a past week is one tap + one confirm instead of N per-meal
  taps, and the destructive step is informed (pictures) and reversible
  (exact-state undo) — the two properties ADR-0030 exists to guarantee.
- The current plan IS replaced, not merged: "cook that week again" means
  *that* week, and the preview says so before it happens. Households that
  want to append a single meal keep the per-card "Add to plan".
- The affordance rides the existing period pills for free: with "Past 30
  days" selected, only recent weeks offer re-planning; "All time" reaches
  the older loops the six-month users actually repeat.
- Serves at today's default, not the historical one: ADR-0037's remembered
  household count is authoritative at re-plan time; the old plan's
  per-meal counts are deliberately NOT replayed (a household that changed
  size does not want the old number resurface silently).

## Alternatives considered

- **A plan-picker modal listing every past week.** Rejected: duplicates
  what the History tab already renders as groups; the group header is the
  picker.
- **Merge into the current plan instead of replace.** Rejected: weakens
  the replace-and-undo contract (ADR-0030) and makes "repeat that week"
  ambiguous; merging one meal already has the per-card button.
- **Replaying the historical per-meal servings.** Rejected: contradicts
  ADR-0037's "one remembered household default" model and silently
  resurfaces stale counts.
- **Reusing `AutoPlanDialog` itself.** Rejected: it is coupled to the
  proposal chooser (ADR-0080 — generation, plan letters, mode toggles);
  re-planning a known meal set needs only the ADR-0030 confirm grammar.

## Change note (2026-10-14, PR #87 review round)

Three review findings hardened the implementation without changing the
architecture:

1. **The preview always resolves the FULL group.** §2's "the group's meal
  set is derived on demand" now explicitly reads the group from the
  UNWINDOWED `plan.cookedHistory` (`planGroupById`), not from the
  tab's currently selected period slice: the period pills (All time /
  30 / 90 days) window only what is DISPLAYED, so a plan whose cooks
  straddle a cutoff still re-plans as its whole week. Resolving by
  planId at read time also keeps the preview current with dishes a
  household peer cooks while the modal is open.
2. **The undo restores the confirm-time plan IDENTITY too.** "Exact
  state" (§3) includes the displaced plan's ADR-0034 identity:
  `replacePlan` mints a fresh id on every call, and a minted-again undo
  used to file the displaced plan's NEXT cooks under a third id,
  splitting its history group. `replacePlan` gained an optional
  `identity` parameter that only the undo passes; every other caller
  (Auto-Plan replace, inbound room snapshots) still mints, per the
  standing "a wholesale replacement IS a new plan" rule. PRESENCE of
  the parameter means "restore this state": an id installs it, an EMPTY
  id restores the confirmed-over no-identity state verbatim (a plan
  hydrated from a pre-ADR-0034 blob is non-empty with planId '' —
  minting over it would change its provenance).