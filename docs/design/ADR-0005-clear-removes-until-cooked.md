# ADR-0005: Clearing the grocery list removes ingredients until cooked

- **Status:** accepted
- **Date:** 2026-09-26 (v0.4.0)
- **Supersedes:** the v0.3.0 "clear = uncheck everything" behavior
- **Decides:** the semantics of "Clear list"

## Context

v0.3.0 shipped clear-as-uncheck: it wiped the checkbox map, but the
plan stayed, so the derived list instantly rebuilt and every ingredient
reappeared — the owner explicitly asked for removal, not unchecking,
with removal lasting as long as the recipe isn't cooked.

## Decision

- Clear snapshots each planned meal's ingredient names (nameKey keys)
  into persisted `plan.clearedIngredients[variantId]`, clears the
  checkbox map and custom items. Meals REMAIN in the plan.
- Aggregation excludes cleared keys **per meal, before merge** — a
  shared ingredient stays visible if any non-cleared meal uses it.
- Removed ingredients return when the recipe is **re-planned**
  (`addToPlan` on a not-currently-planned variant deletes its entry)
  or the meal is **marked cooked** (which removes the meal from the
  plan and forgets its cleared entry).
- `clearedIngredients` is household state and rides the room payload
  (`cleared` field). `cookedHistory` stays personal.
- UI gains a distinct "cleared-empty" state on Grocery + Shopping
  views (between "nothing planned" and "has items").

## Consequences

- One-item lists and edge flows (toast replacement/timeout) must keep
  firing exactly once — the auto-trigger watches the checkbox Map
  deeply, never the derived counts (plan edits shift counts without
  checkboxes moving, and must not prompt).
- The prompt toast's `prompting` guard resets via the toast's
  `onDismiss` (every end path), or the flow wedges permanently.

## Alternatives considered

- **Hide cleared items via a UI filter only** — rejected: the list
  must be truly empty for household members joining later with no
  checkbox state.
- **Restore button UI** — deferred; re-plan/cook covers the need.
