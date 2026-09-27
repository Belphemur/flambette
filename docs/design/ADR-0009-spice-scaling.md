# ADR-0009: Sub-linear, capped scaling for seasonings

- **Status:** accepted
- **Date:** 2026-09-28 (phase 11)
- **Decides:** how ingredient quantities scale with servings

## Context

Basic ingredients scale linearly with servings (1 cup rice for 4 → 1.5
cups for 6). Spices, condiments and seasonings do not — more servings
don't need proportionally more salt, pepper or curry powder. The grocery
list and the cooking steps scaled *everything* linearly, so seasonings
blow up absurdly at high serving counts (36 servings → 6× the salt).

All 2,730 catalog recipes have an authored `serving_count` of 6
(verified over `public/data/recipes/*.json`), so `serving_count` is the
scaling base everywhere.

## Decision

One shared helper in `src/lib/recipe.ts`; both consumers call it:

- **Classification** — `isSeasoning(text)`: case-insensitive substring
  match of the ingredient name (or a step-detail line, which embeds the
  name after its quantity) against the curated `seasoningNames` keyword
  set (`salt`, `black pepper`, `cumin`, `paprika`, `oregano`, `garlic
  powder`, …). Exclusion substring `bell` vetoes a match so "red bell
  pepper" stays linear.
- **Scaling** — `scaleQuantity(q, base, target, isSeasoning, name?)`:
  - non-seasonings: `round3(q × target/base)` — unchanged linear path;
  - seasonings: `q × (target/base) ** 0.75` (sub-linear growth);
  - cap: the `servingCaps[nameFragment]` absolute ceiling in the
    ingredient's own unit when one matches (most specific fragment
    wins), otherwise `2 ×` the authored amount; the cap only ever
    tightens (`min` of the two).
  - `round3` kills float drift; display formatting stays
    `formatAmount` (1 decimal) so existing grocery output is stable.

**Consumers:** `src/lib/grocery.ts` (per-recipe contribution, so caps
apply per recipe, not per summed list) and `scaleSteps()` in
`recipe.ts` (cooking-view / detail-sheet step detail lines).

### Deviation from the locked pseudocode (recorded deliberately)

The brief's sketch read `scaled = q * Math.min(1.0, (target/base)**0.75)`.
Taken literally, the `Math.min(1.0, …)` clamps the factor to 1 whenever
scaling UP — seasonings would never grow at all, making `servingCaps`
and the "default cap = 2×" dead code and contradicting the same brief's
"grows slowly, caps hard". Implemented as `q × (target/base)**0.75`
with the cap bounding growth. The observable gate ("at 12 servings a
seasoning shows visibly less than 2×, linear items show ~2×") holds:
e.g. ¾ tsp crushed red pepper at 12 servings renders `1.3 tsp` (linear
would be `1.5 tsp`), and `1 ½ tsp salt` at 24 servings is held at
`3 tsp` by the default cap (sub-linear alone would give ≈ 4.2 tsp).

### Curation notes

The brief's raw keyword list had two foot-guns, fixed because
classification drives real amounts:

- bare `pepper` would cap bell/green peppers → keywords are
  `black pepper` / `white pepper` / `red pepper` (the latter covers
  "red pepper flakes" and "crushed red pepper"), with the `bell` veto;
- bare `cloves` would cap garlic ("6 cloves garlic") → the spice only
  matches as `ground cloves` / `whole cloves`.

## Consequences

- Seasonings grow ~1.68× when servings double, and can never exceed the
  cap (2× authored by default) within one recipe.
- `RecipeDetail`'s ingredient sheet still uses the linear text-based
  `scaleQuantity` from `quantity.ts` (out of scope this phase); the
  grocery list and cooking steps are seasoning-aware. Follow-up if the
  inconsistency bothers anyone: route the detail sheet through the same
  helper.
- Pantry seasonings with empty `quantity` in `line_items` keep passing
  through the grocery list verbatim (nothing to scale).

## Alternatives considered

- Unit-aware caps (`cup=2 / tbsp=4 / tsp=6` style): ambiguous when a
  name maps to several units across recipes; the per-recipe 2× default
  achieves the same bound without a unit taxonomy.
- Scaling in the display layer only: rejected — grocery aggregation
  sums contributions, so the scaling must happen per contribution.
