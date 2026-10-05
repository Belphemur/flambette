---
name: add-recipe
description: >-
  Add a household (user) recipe to the app: artifact entry, CIQUAL-derived
  nutrition, images, and the gates that keep it a catalog citizen. Follows
  ADR-0054.
version: 1.0.0
---

# Add a User Recipe

Procedure for adding a household-authored recipe (from the owner's markdown
plus a photo) as a first-class catalog entry — the pancake is the reference
implementation. **Authoring is a script, never a hand-edited artifact:** the
nutrition block is derived from the committed CIQUAL table, and hand-typing
it is exactly the fabrication ADR-0054 forbids.

## Where things live

| Concern | Path |
| --- | --- |
| Design decisions (READ FIRST) | `docs/design/ADR-0054-user-recipes-and-source-filter.md` |
| Runtime merge + parsing | `src/lib/catalog.ts` (`parseUserRecipes`, `buildCatalog`) |
| Pure helpers (badge, ids) | `src/lib/userRecipes.ts` |
| Authoring reference script | `scripts/add_user_recipe_pancake.py` |
| CIQUAL table generator | `scripts/build_ciqual_nutrition.py` |
| Committed table | `public/data/ciqual_foods.json` |
| Artifact | `public/data/user_recipes.json` |
| Images | `public/img/recipes/{thumbnail,presentation}_user_recipe_<slug>_<hash>.webp` |

## Procedure

1. **Read ADR-0054.** You must be able to state, before writing anything:
   the id band (900 000+, catalog max 40 919), the merge model (user metas
   appended into `variantMeta` at load — no parallel engine), and the two
   non-expiring facts (authorship permanent; badge 30 days).
2. **Normalize the recipe.** Metric quantities; every ingredient as a
   `(quantity, ingredient_name)` pair; the serving count the batch actually
   IS (the pancake is 8 — do not coerce to 6); per-step prose with the
   fields the catalog's `instructions` schema uses
   (`primary_message`, `secondary_message`, measured amounts live in the
   secondary lines per ADR-0022). Names reuse the FROZEN catalog's exact
   spelling so grocery lines MERGE (`flour` not `all purpose flour` if the
   catalog says `flour`).
   ✅ Check: no ingredient without a parseable or documented quantity.
3. **Check/extend the CIQUAL table.** Cross-check every ingredient nameKey
   against `public/data/ciqual_foods.json` `foods`. A missing row means:
   find the food's `alim_code` in the extracted XMLs (grep `alim_nom_eng`),
   add an audited `INGREDIENT_MAP` entry with a `choice:` reason recording
   WHY that code and NOT its near neighbours (flour is 9435 T65, NOT the
   self-raising 9437; butter is the UNSALTED 16400), then re-run
   `CIQUAL_XML_DIR=<dir> python3 scripts/build_ciqual_nutrition.py`.
   Count units ("3 large eggs") need a `UNIT_GRAMS` entry; volume needs
   `LIQUID_DENSITY`. The generator REFUSES an unconvertible quantity rather
   than emitting a partial block — that refusal is the contract, do not
   work around it.
   ✅ Check: script exits 0, prints one derived line per food.
4. **Write the authoring script.** Copy `scripts/add_user_recipe_pancake.py`,
   rename for the new recipe. Load-bearing conventions (each one has been a
   real bug class before):
   - `meta.macros` are CALORIE FRACTIONS summing to 1.0 (fats 0.41 = 41% of
     serving kcal), never grams — the card plots them directly and grams
     rendered as "1686% fat" once.
   - `meta.calories` / `meta.sodium_mg` are PER SERVING (ADR-0004), straight
     from the derived block.
   - `ingredient_names` must be a plain `string[]` (the search index joins
     it unguarded; `parseUserRecipes` now REJECTS entries without it).
   - `first_published_at` may be left absent — `buildCatalog` mirrors
     `addedAt` into an ABSENT field, but an authored value is kept verbatim.
   - `variety_tag_ids: []` — do not invent Mealime taxonomy ids.
   - `published_recipe_uuid: ""` (no CDN doc; the doc is embedded).
   Allocate the variant id via `nextUserRecipeId` semantics (one past the
   artifact's highest, never below the band — the python loaders enforce
   both gates loudly).
   ✅ Check: script exits 0; derived fractions sum to 1.0.
5. **Images.** Center-crop square from the owner's photo; encode
   `thumbnail` 300×300 and `presentation` 600×600, RGB, lossy webp q80-82
   (the CATALOG norm — earlier pancake files at other sizes were an
   outlier). Keep the stem stable so `images.ts`'s basename mapping
   resolves without code change.
   ✅ Check: both files exist at exactly those dimensions.
6. **Temperatures in step prose.** Author Celsius only (`Preheat oven to
   220C`). Do NOT hand-write dual notation `220C (425F)` — the dual pair is
   added at render time by `localizeText` in `src/lib/units.ts`, and a
   hand-authored pair can be misinterpreted as two independent
   temperatures (the sloppiness tolerances exist for the CATALOG's legacy
   text, not for new authoring).
   ✅ Check: `localizeSteps` over the doc in imperial mode shows `(…°F)`
   pairs once, not twice-converted values.
7. **Run the gates, in order, and do not report any you did not run:**
   ```bash
   bun run test:unit        # was 557 pass (ciqual goldens included)
   bun run data:verify      # pack-index parity + nutrition --check
   bun run test:data        # 5 generator goldens
   timeout 600 bun run build   # green; pages = 2759 + user recipes
   ```
   A failing golden is DRIFT, not flake: update the pin only when the new
   number is correct, and record why in the commit body.
8. **Commit by explicit path** (never `git add -A` at the root: scrape
   scripts/raw archives are gitignored but sit in the workdir). Add the
   script, the artifact, ciqual table if extended, regenerated artifacts
   (`ingredients.json` census gains the recipe's ingredients), images, and
   the ADR if a decision changed. Push; the PR's preview gives the owner a
   card to eyeball.

## Display trivia that has bitten before

- Servings seeding: user recipes open at their AUTHORED serving count;
  Mealime recipes at `ui.defaultServings` (RecipeDetail ~line 226).
- Scaled display rounding lives in `humanizeAmount`/`humanizeScaledQuantity`
  (`src/lib/quantity.ts`): counts round DOWN (2.25 large eggs → 2),
  mass/volume → integer from 5 units up, spoons keep decimals.
- One scaler for every display surface: `scaleQuantity` in
  `src/lib/recipe.ts` (seasoning-aware). Do not reintroduce a linear one.
- Grocery: container units ceil-merge (ADR-0017), linear units add,
  seasonings sub-linear capped (ADR-0009).
- Supplemental ingredient rows in `scripts/extract_ingredients.py` must be
  REMOVED once a user recipe line-items the name (it stops being a filler
  and gains an observed unit; `test_extract_ingredients.py` enforces it).

## Pitfalls

- `meta.ruleset` values are the CATALOG's five (breakfast, dinner, simple,
  dessert, snack) — anything else lands unmatched and the chip disappears.
- `serving_count` must be ≥ 1; nutrition divides by it.
- Image stems are load-bearing across `images.ts`, `generate-recipe-seo.ts`
  and the sitemap — rename nowhere casually.
- Timer sidecars: omit the `<variantId>.timer.json` file entirely when the
  recipe has zero timer hints (the on-demand 404 is the affordance).
- User-facing copy for household recipes never mentions Mealime.

## Verification

- `bun run test:unit`, `bun run data:verify`, `bun run test:data`,
  `bun run build` — all green on a FRESH checkout (locally cached CIQUAL
  XMLs don't count; the committed table is the truth).
- The app (dev or preview) shows: grid card with NEW badge, detail sheet
  seeded at authored servings with the authored amounts (no "2.3 large
  eggs"), cooking view chips + timers, and the nutrition modal with sane
  percentages.
- Adding the recipe to a plan merges its groceries into the expected store
  sections without a duplicate line for a catalog-named ingredient.
