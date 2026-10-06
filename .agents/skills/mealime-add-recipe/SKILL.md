---
name: mealime-add-recipe
description: Add a household recipe, ADR-0054 — strict temperature format.
version: 1.0.0
author: Antoine Aflalo (Belphemur), Hermes Agent
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [Mealime, Recipes, CIQUAL, Data, flambette]
    related_skills: [mealime-planner-dev, mealime-catalog-data, flambette-adr-records]
---

# Add a User Recipe to flambette

Procedure for adding a household-authored recipe (from the owner's markdown
plus a photo) as a first-class catalog entry — the pancake is the reference
implementation. Authoring is a SCRIPT, never a hand-edited artifact: the
nutrition block is derived from the committed CIQUAL table, and hand-typing
it is exactly the fabrication ADR-0054 forbids.

## When to Use

- The owner hands you a recipe (markdown, text or recipe-app export) + a photo.
- Editing or re-deriving an existing user recipe (same script, idempotent).
- Don't use for: touching the FROZEN Mealime catalog (`scripts/sync_catalog.py`
  governs that; user recipes never enter its source data), or for
  ADR-numbered design questions (see `flambette-adr-records`).

## Prerequisites

- Worktree of `Belphemur/flambette` with `bun`, `python3` + Pillow.
- CIQUAL XMLs once: `python3 scripts/build_ciqual_nutrition.py --download`
  (cache `scripts/.ciqual/`, gitignored; `CIQUAL_XML_DIR` overrides).
- Read `docs/design/ADR-0054-user-recipes-and-source-filter.md` first — the
  locked decisions are load-bearing, not commentary.

## Procedure

1. **Read the ADR.** Completion criterion: you can state the id band
   (900 000+, catalog max 40 919) and the merge model (metas appended into
   `variantMeta` at load — no parallel engine; authorship permanent, badge
   30 days).
2. **Inspect the recipe**: ingredients with quantities + units, serving
   count, per-step prose, oven/temperature notes, times. Metric preferred;
   convert cups→g/ml yourself, never fabricate a conversion you cannot
   source. Completion criterion: every ingredient has (quantity, name).
3. **Check the CIQUAL table** covers EVERY ingredient `nameKey`
   (`public/data/ciqual_foods.json`). Missing rows are added to
   `INGREDIENT_MAP` in `scripts/build_ciqual_nutrition.py` with an
   `alim_code` found in the XMLs and a `choice:` reason naming WHY that
   code (the plain flour, not the self-raising; the UNSALTED butter).
   Missing count units ("large egg") go into `UNIT_GRAMS`; missing volume
   densities into `LIQUID_DENSITY`. Then
   `CIQUAL_XML_DIR=<dir> python3 scripts/build_ciqual_nutrition.py`.
   Completion criterion: every ingredient resolves with no SystemExit.
4. **Write an authoring script** mirroring
   `scripts/add_user_recipe_pancake.py` (copy, rename). `LINE_ITEMS` as
   (quantity, ingredient_name) reusing the CATALOG's exact spelling so
   grocery lines merge; `INSTRUCTIONS` as (primary, secondary|None) —
   secondary lines carry the per-step measured amounts (ADR-0022). Derive
   `nutrition`, `meta.calories`, `meta.sodium_mg` and `meta.macros` ONLY
   through `recipe_nutrition()` (never transcribe). `meta.macros` are
   CALORIE FRACTIONS summing to 1.0, not grams.
   Completion criterion: script exits 0; fractions sum to 1.0.
5. **Images**: center-crop square → `300×300` thumbnail and `600×600`
   presentation, RGB, lossy webp q80-82, filenames
   `{thumbnail,presentation}_user_recipe_<slug>_<hash>.webp` under
   `public/img/recipes/`; keep the stem stable so `imageSrc` resolves.
   Completion criterion: both files exist at the exact dimensions.
6. **TEMPERATURE FORMAT (MANDATORY).** Step prose writes temperatures in
   the signed grammar the client localizes — the dual pair is the
   preferred authoring form (it is what the UI's dual mode shows).
   - PREFERRED: the catalog-style dual pair — `Preheat oven to
     220°C (425°F)` / `in a 90°C (194°F) oven`. Both sides signed; the °F
     value should be `round(°C × 9/5 + 32)` when known. `PAIR_TOLERANCE_C`
     (= 7) in `src/lib/units.ts` is generous: any pair restating the SAME
     temperature (within ~7°C of each other) collapses to one token per
     single-system display; only a parenthetical stating a genuinely
     DIFFERENT temperature (>7°C apart) converts independently.
   - MINIMUM: signed Celsius alone (`in a 90°C oven`) — the display adds
     the °F half at render time in single-system modes.
   - FORBIDDEN: unsigned tokens (`220C`, `220 C`, `220c`); `TEMP_RE` in
     `src/lib/units.ts` requires the degree sign, so an unsigned mention
     is prose and an imperial reader sees no conversion.
   Completion criterion: `localizeText(doc, 'dual')` keeps both tokens
   verbatim; `metric`/`imperial` each show exactly ONE temperature per
   same-temperature mention.
7. **Gates, in order, and never report one you did not run:**
   `bun run test:unit` → `bun run data:verify` → `bun run test:data` →
   `bun run build` (pages = 2759 + user recipes). A failing generator
   golden is DRIFT, not flake: update the pin only when the new number is
   correct, with the reason in the commit body.
   Completion criterion: all four green.
8. **Commit by explicit path** (never `git add -A` at repo root: scrape
   scripts/raw archives sit gitignored in the workdir). One commit per
   recipe incl. artifacts + images. Push, let the PR's preview deploy for
   the owner to eyeball the card.

## Quick Reference

- Id band: `USER_RECIPE_ID_BASE = 900_000`; allocate via `nextUserRecipeId`
  semantics (python loaders enforce the band + duplicate gates loudly).
- Servings: the authored batch size is DATA (pancake = 8); RecipeDetail
  seeds user recipes at their authored count, Mealime ones at
  `ui.defaultServings`.
- Display rounding: `humanizeAmount`/`humanizeScaledQuantity`
  (counts round DOWN: 2.25 eggs → 2; mass/volume → integer ≥5 units).
- ONE scaler everywhere: `scaleQuantity` in `src/lib/recipe.ts`
  (seasoning-aware); the linear form is deleted.
- Grocery merge: containers ceil-merge (ADR-0017), linear adds, seasonings
  sub-linear capped (ADR-0009).
- CIQUAL `-` = not measured: a nutrition key ships only when EVERY
  contributing food publishes it — partial sums never ship.
- No "Mealime" wording in user-facing copy for household recipes.

## Dietary Restrictions (ADR-0056)

User recipes are NOT covered by the dietary-restriction mechanism, and that
is the documented behaviour, not a gap: the restriction artifacts (`removed`
sets and `restriction_overlays/`) are keyed by upstream `recipe_id` and
sourced from upstream's own restricted renderings, so the mechanism can
never produce a variant for a household recipe. A user recipe therefore
stays visible under EVERY active restriction, and its ingredient text stays
authentic — the same rule as ADR-0057's authored-prose rule.

If the author WANTS a restricted variant (say, a gluten-free version of the
pancake), add it as a SEPARATE household recipe — upstream's own model:
restricted variants are per-recipe authored docs, not a runtime transform.
When naming its substituted ingredients, use the CATALOG's substitution
vocabulary where one exists, so the grocery list reads consistently next to
upstream recipes under the same restriction (`gluten-free rotini pasta`,
`tamari soy sauce`, `virgin coconut oil`, `natural almond butter`, …).

The authoritative substitution vocabulary is the committed data:
`public/data/restriction_sets.json` (which restriction removed what) and
`public/data/restriction_overlays/<slug>.json` (upstream's own reworked
ingredient names, per doc). Grep an overlay for the ingredient being
substituted before inventing a spelling of your own.

## Pitfalls

- **Never hand-edit `user_recipes.json`.** The next authoring run
  overwrites it, and hand edits break the `--check` drift gate loudly.
- **`formatAmount(2.25)` = `"2.3"`** — 1-decimal rounding is why "2.3
  large eggs" appeared once; rounding happens at the humanize layer.
- **`meta.macros` are fractions** — a grams reading once rendered as
  "1686% fat" on the card.
- **`data:verify` runs `--check`** on the ciqual table: hand-editing a
  derived block fails CI, by design.
- **Supplemental ingredient rows in `extract_ingredients.py` must be
  REMOVED** once a user recipe line-items the name (it stops being a
  filler; the golden enforces it).
- **Timer sidecars**: omit `<id>.timer.json` entirely for zero-hint
  recipes (the on-demand 404 is the affordance).

## Verification

- Preview: card + NEW badge, detail sheet seeded at authored servings with
  authored amounts (no "2.3 large eggs"), cooking view chips + timers,
  nutrition percentages sane.
- `bun run data:verify` + `bun run test:data` clean on a FRESH checkout —
  they prove the committed table, not your local cache.
