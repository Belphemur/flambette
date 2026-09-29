# ADR-0030: Auto-Plan previews the pack before it replaces the plan

**Status:** Accepted (2026-09-29)
**Extends:** ADR-0024 (Auto-Plan pack builder). Adds a preview to the
confirm step; the planner, its scoring and its determinism are untouched.

## Context

ADR-0024's Auto-Plan is a deterministic pack builder whose whole point
is *why* it picked what it picked: it maximises whole packages bought
and minimises waste. Its confirm step, though, printed

> Found a 4-meal pack buying 37 packages. Replaces your current plan
> (6 meals).

Two numbers and a warning. The user is asked to accept a destructive
replacement of a hand-curated plan — with an undo toast as the only way
back — without being shown a single recipe.

## Decision

The confirm step renders the pack: one tile per picked meal with its
**image and title**, above the existing count/packages summary.

- `PackPlan.variantIds` is resolved through the in-memory catalog
  (`catalog.byId`) and rendered with `imageSrc` / `onImgError` — the
  exact helpers `RecipeCard` and `PlanTab`'s own meal rows already use,
  so the preview, the plan and the grid cannot disagree about a picture.
  **No new image path scheme and no new fetch**: the files are the
  bundled offline ones, with the same neutral placeholder on error.
- A tile carries `data-test="auto-plan-meal-<variantId>"`, the block is
  `data-test="auto-plan-preview"`, and the e2e case asserts the tiles
  match the plan that confirming produces.
- Counts, package count, the warning text, the confirm button, the
  "Keep editing" escape and the exact-state undo toast are all
  unchanged. The preview is additive.

## Consequences

- Accepting a replacement is an informed decision, and the pinned
  default pack `[4908, 6185, 6729, 12069]` is now visible before it is
  accepted rather than only afterwards.
- A variant id with no catalog meta simply has no tile (the same
  defensive `flatMap` the Plan tab's meal list uses) — the counts line
  still reports the planner's number, because the planner's count is the
  planner's business.

## Alternatives considered

- **A confirmation dialog listing names only.** Rejected: on a phone the
  difference between two recipes is largely their picture, and the
  images are already on disk.
- **Re-planning without replacing (merge).** Rejected: out of scope for
  this change, and it would weaken ADR-0024's explicit
  replace-and-undo contract.
