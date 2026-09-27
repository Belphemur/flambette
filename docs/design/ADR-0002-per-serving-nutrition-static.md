# ADR-0002: Per-serving nutrition is static, never scaled

- **Status:** accepted
- **Date:** 2026-09-22
- **Decides:** how calories/sodium react to the servings stepper

## Context

`nutrition.energy` and `nutrition.sodium_mg` in the scraped docs are
**already per-serving** (verified: 608.8 kcal average across all 2,730
recipes, every recipe `serving_count: 6`). The first implementation
scaled them by the servings factor while labelling them "kcal /
serving", which made the displayed per-serving value change as the user
stepped servings — nonsense on its face.

## Decision

`meta.calories` and `meta.sodium_mg` display **unscaled, static
per-serving values** everywhere (RecipeDetail, PlanTab rows). Only
recipe totals (and shopping-list quantities) scale with the servings
factor.

## Consequences

- Any new nutrition display must re-check this rule before scaling.
- e2e pins one recipe's kcal as invariant under servings changes.

## Alternatives considered

- **Scale by factor and relabel as "per plan"** — rejected: the label
  the product needs is per-serving; scaling just changes the number's
  meaning, not the data.
