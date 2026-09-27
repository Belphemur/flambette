# ADR-0003: Grocery list is derived, merged by normalized keys

- **Status:** accepted
- **Date:** 2026-09-22
- **Decides:** how the grocery list is computed from the plan

## Context

The grocery list must aggregate across planned meals, scale each
meal's ingredients to its servings, merge shared ingredients ("2 recipes"
provenance), and keep unit spellings coherent (`2 cups` + `1 cup` →
`3 cups`; `cups`→`cup`; plural classes like `potatoes`/-oes).

## Decision

The grocery list is **always derived**: `src/lib/grocery.ts`
(`aggregateGroceries`) + `src/lib/useGroceryList.ts` compute it from
`plan.plan` + `plan.customItems` on the fly. Nothing persists a
materialized grocery list. Merging happens on two normalized keys:
`nameKey` (lowercase, singularized, plural-class aware) and `unitKey`
(unit normalization). Each merged item carries a provenance list
(`recipes[]`) that drives the "N recipes" pill.

## Consequences

- Views must never duplicate aggregation logic; a new grocery surface
  (e.g. shopping mode) reuses the shared lib.
- The v0.4.0 cleared-ingredients exclusion plugs into this single
  aggregation point, per meal **before** the merge.
- Provenance pill must stay a flex sibling OUTSIDE the truncating
  name span — inside it, `overflow-hidden` clips its tooltip.

## Alternatives considered

- **Persisted grocery store updated on plan edits** — rejected:
  second source of truth; every plan mutation has to mutate two stores
  in sync (the phase-7 clear bug class came from exactly this shape).
