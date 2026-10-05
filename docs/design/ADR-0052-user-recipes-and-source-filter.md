# ADR-0052: User recipes live in the catalog, and "source" replaces the PRO filter

* Extends: ADR-0001 (offline frozen catalog), ADR-0027 (unified quick
  filters), ADR-0024 (Auto-Plan pack builder), ADR-0036 (design tokens +
  icon roles), ADR-0045 (shared FilterDropdown), ADR-0043 (recipe-type
  filter)
* **Supersedes, in part:** the `proOnly` member of ADR-0027's
  `QuickFilters` (the filter SURVIVES; its meaning changes — see §3). The
  accepted ADR-0027 file is not edited; this one replaces the member.
* Status: **Accepted** (2026-10-05)
* Companions: `public/data/user_recipes.json` (new artifact),
  `src/lib/catalog.ts`, `src/lib/userRecipes.ts` (new, pure),
  `src/lib/quickFilters.ts`, `src/components/RecipesTab.vue`,
  `src/components/RecipeCard.vue`, `scripts/build_ciqual_nutrition.py` (new),
  `scripts/catalog_paths.py`, `scripts/build_pack_index.py`,
  `scripts/extract_ingredients.py`, `scripts/extract_recipe_types.py`,
  `public/data/ciqual_foods.json` (new committed artifact),
  `scripts/test_build_ciqual_nutrition.py` (new goldens)

## Context

The catalog is Mealime's, frozen at 2,759 variants (ADR-0001), and every
engine in the app — search, diets, the grocery derivation, Auto-Plan,
favourites, ratings, the cooking view — is written against the shape of
`builder_data.json` + `public/data/recipes/<id>.json`. The owner now wants
to add a recipe of their OWN (the first is a buttermilk pancake) and to
be able to find it again.

That request has two halves, and the second one is the awkward half.

**The data half is easy if user recipes become catalog entries.** A user
recipe merged into `variant_meta` + `variant_data` + a recipe document is
already: searchable, plannable, grocery-derivable, cookable, starable,
rateable, and syncable to a room. Every one of those engines works
unchanged. A parallel "my recipes" store would have to be taught to each
of them separately, and each omission would be a bug.

**The filter half has nothing to do with the recipe.** The Recipes tab
today carries a `proOnly` chip — "PRO recipes only" — which is a
commercial badge filter. It was never a source filter, and it is the only
filter on the tab that has nothing to say about the food. With user
recipes in the catalog the question users actually ask becomes "show me
mine, or show me theirs", and a chip labelled PRO cannot answer it.

**Nutrition is the honesty constraint.** A catalog document carries a
66-key `nutrition` block per serving (ADR-0004), and the detail sheet
renders all of it (ADR-0039). Hand-writing those numbers for a user
recipe would be fabrication: the numbers would look exactly as
authoritative as Mealime's and nobody could tell. They have to be
derived, from a real composition table, by a committed artifact, with the
provenance recorded.

### Alternatives considered

* **A `myRecipes` Pinia store holding docs, merged at render time** —
  rejected. Every engine above would need a second code path, and the
  first one anybody forgot (Auto-Plan, most likely) would silently not
  see the recipe.
* **Keep the PRO chip and add a second "Mine" chip** — rejected. The
  filter row is already a 2-column grid on a Pixel 7 (ADR-0027 WS1) and
  cannot take a fifth control; and "PRO" is a plan upsell, not a source.
* **Keep the pancake's numbers out of `nutrition` (leave the block null)**
  — rejected. The facts modal is a first-class surface (ADR-0039); a
  pancake with an empty facts panel reads as a broken recipe, and a
  fabricated panel is worse.
* **USDA FoodData Central** — considered and distrusted: it needs an API
  key, the terms read as "no redistribution of bulk data", and its
  values are US retail products. **Fineli (fineli.fi)** was the first
  choice and is unreachable from the build machine (Cloudflare blocks
  every path, in curl AND in a real browser; a fetch that "sometimes
  works" cannot back a committed artifact), so it is out on
  availability, not quality. **CIQUAL 2020 (ANSES, France)** is the
  answer: one unauthenticated 3.5 MB zip published as open data and
  listed on data.gouv.fr, XML with a documented confidence code and
  source, and EU 1169/2011 energy values so the energy figure is the one
  a European label would print.

## Decision

### 1. One artifact, merged at load (`public/data/user_recipes.json`)

User recipes live in a single committed JSON file:

```jsonc
{
  "version": 1,
  "recipes": [
    { "addedAt": 1757..., "meta": { /* VariantMeta */ },
      "data": { /* VariantData */ }, "doc": { /* RecipeDoc */ } }
  ]
}
```

`catalog.ts` fetches it **in parallel** with `builder_data.json` and, in
`buildCatalog`, appends `meta` to `data.variant_meta`, `data` to
`dataById`, and registers `doc` in a `userDocs: Map<number, RecipeDoc>`
that `getRecipe()` consults **before** its `data/recipes/<id>.json`
fetch. The fetch is `Promise.allSettled`-shaped: a missing or malformed
`user_recipes.json` degrades to "this build has no user recipes" and
never fails the catalog load. That is the "graceful degrade" the app
already has to have, because the file is a build output that a partial
deploy can be missing.

**Ids come from a reserved high band: `USER_RECIPE_ID_BASE = 900_000`,
first user recipe `900_001`.** The highest Mealime variant id is 40,919,
so the band is unreachable by a catalog sync. The band is a RESERVATION
that keeps the two id spaces from ever colliding, not a membership test:
"is this ours?" is answered by the loaded artifact's id set
(`isUserRecipeId(id, ids)` in `src/lib/userRecipes.ts`), because a stale
id left in the band by a deleted recipe would keep being documented /
selectable there. `data/recipes/<id>.json` is not read for a user
recipe — `getRecipe()` serves the embedded doc from memory, so no fetch
ever touches the frozen directory on their behalf.
Every engine that only receives a `VariantMeta` therefore works with no
lookup beyond the already-merged `dataById`.

**Why the doc rides in this file rather than a second
`data/recipes/<id>.json`:** a doc-only design makes the meta's existence
depend on a second file that nothing indexes. `build_pack_index.py`
would have to discover user recipes by filesystem convention, and
`catalog_paths.recipe_doc_paths()` — which deliberately keeps a
`^\d+\.json$` numeric glob so the ADR-0041 `.timer.json` sidecars cannot
fold in — would start walking user docs, quietly changing the counts the
other two generators assert. One file, one loader, one place a reviewer
looks. `scripts/catalog_paths.py` gains `user_recipe_docs()` and the
three catalog walkers consume `recipe_doc_paths() + user_recipe_docs()`.

The `!= 2,730` warning in `extract_ingredients.py` and the
`expected = len(builder["feasible_variants"])` check in
`build_pack_index.py` **stay warnings**, and the user-recipe count is
added to the expected total: the catalog is deliberately extensible now,
so a count mismatch is a signal to re-run the generators, not a failure.

### 2. Auto-Plan eligibility is unchanged, and the pancake is in the index

A user recipe is a first-class candidate: `build_pack_index.py` emits a
row for it (L2 of the brief), so Auto-Plan can pick it. The
`feasible_variants`-derived eligibility loop in `useAutoPlan` iterates
`catalog.dataById`, and the pancake's `variant_data` entry puts it in
there, so nothing in `useAutoPlan` changes.

The default Auto-Plan pack is a **dinner** pack, and the pancake's
`ruleset` is `breakfast`, so the e2e dinner pins
(`[17452, 9889, 6389, 6167]`) are expected to HOLD. They are re-verified
with `scripts/probe_autoplan_pin.ts` rather than assumed, and re-pinned
from the probe's output if they do move. What does move is the
`mealType` facet: `recipe_types.json` is regenerated so the pancake is
counted in `breakfast` and in the `-5` ("all") total.

### 3. `source` replaces `proOnly` (one spelling, in one place)

`QuickFilters.proOnly: boolean` is gone. In its place:

`type SourceFilter = 'all' | 'pro' | 'new'` — the brief's locked
spelling. `all` = everything, `pro` = `meta.is_pro`isters (the old chip,
a rename not a reinterpretation), and `new` = the user-recipe id set
(locked L1: permanent). persisted under the existing
`mealime-planner:v1:ui` slice, shared with the room like every other
member of ADR-0027's household half, and coerced in exactly one place:
`normalizeQuickFilters`, which is the single inbound gate for backup
import and remote snapshots alike. An unknown value falls back to
`'all'`, on the same "a stale peer must never park the tab on an empty
grid" rule the diet ids and `mealType` already follow.

**Migration is inside `normalizeQuickFilters`, not a new function.** A
payload carrying `source` wins. A payload carrying only the legacy
`proOnly` maps `true → 'pro'` and `false → 'all'`. That covers all
three inbound paths (persisted ui blob, backup JSON, an older peer's
room snapshot) with one branch, and it means the type never carries both
spellings — a second spelling in the persisted type is exactly the drift
this repo's conventions forbid. The mapping is deliberately
`true → 'pro'`: a household that had pinned "PRO only" keeps exactly
the narrowed grid they chose, not the one the old chip's label implied.

### 4. The source control is a dropdown, and the three buckets are permanent

Per the brief, the control is a **dropdown with an icon** rendered
through the shared `FilterDropdown` (ADR-0045) — no hand-rolled popup,
so the roving-tabindex listbox, the scrim/Escape handling and the
Pixel 7 fit are the ones the other three dropdowns already have.
Options: **All sources / PRO / New**.

The **`New` bucket is permanent**: it selects every non-Mealime recipe
for as long as it exists, forever (locked decision L1). What expires is
only the **NEW badge** on a card, after `NEW_BADGE_DAYS = 30` from the
recipe's `addedAt`. A recipe the household added in March is still in
the `New` bucket in November; it just stops claiming to be new. The
badge is a claim about recency, the bucket is a claim about authorship,
and only the first one has an expiry.

`src/lib/userRecipes.ts` is pure and owns both facts: `isUserRecipeId`,
`isNewUserRecipe(meta, now)` and the `NEW_BADGE_DAYS` constant, with
bun-test coverage for the boundary (29/30/31 days, and a future-dated
`addedAt` from a clock-skewed device, which reads as new rather than
negative).

The badge sits where `PRO` sits on the card (`bg-surface-dark` chip, top
left) and uses `text-brand-soft`, not the PRO `text-warning-soft`: a
brand-coloured chip is "yours", a warning-coloured chip would say
"something is wrong with this recipe". The dropdown's icons
(`Layers` / `BookOpen` / `UserRound`) are **UI affordances, not food
identities**, so they stay out of `ICON_ROLES` (ADR-0036) and are
`aria-hidden`; the selected option's `aria-label` carries the meaning.

### 5. Nutrition is DERIVED from CIQUAL 2020, at build time, from a committed table

`scripts/build_ciqual_nutrition.py` reads the CIQUAL 2020 edition
(`XML_2020_07_07.zip`), maps the ingredients a user recipe actually uses
onto named CIQUAL foods and writes `public/data/ciqual_foods.json`:

* one row per ingredient `nameKey`, keyed by the SAME key the grocery
  list resolves line items by, holding the chosen CIQUAL `alim_code`, its
  FR/EN name, the worst confidence grade among the rows that made it in,
  an `energy_source` (`ciqual` | `atwater`), the RECORDED reason for the
  choice, and the per-100 g values for every mapped nutrient;
* an audited `INGREDIENT_MAP` table IN THE SCRIPT: every food names its
  `alim_code` and records why it was chosen (flour is 9435 T65 wheat
  flour and NOT the self-raising 9437, which would fold the leavening's
  sodium into the flour and double-count it against the baking-powder
  line; butter is the UNSALTED 16400 for the same double-count reason). A
  documented choice is the deliverable; a silent fuzzy match is not.
* a `unitGrams` table for count units (`{"egg": 50}`, "3 large eggs"),
  because CIQUAL is per 100 g edible portion and a recipe counts eggs;
* a `provenance` block recording the zip URL, the 2020-07-07 release,
  every source XML's sha256, the per-nutrient `const_code`, the accepted
  and refused confidence grades, and the omission rule — CIQUAL has no
  caffeine, no trans fats, no amino acids and no choline, and **a
  nutrient it does not publish is omitted, never written as `0.0`**,
  because "0.0" is a claim and an omission is an absence.

Three CIQUAL conventions the mapping respects, all recorded in the
script: protein is the **Jones factor** (`const_code` 25000, not 25003);
`sugars` (32000) EXCLUDES lactose, so the artifact derives the app's
sugar total as CIQUAL's row plus its lactose, or as the sum of the six
sugar sub-keys when the total row is absent (whole milk); and confidence
grade D is refused globally — granulated sugar's `sucres` row is graded
D despite sucrose being the whole food, so that one food opts in with a
recorded reason rather than reporting 0 g of sugar for a recipe with
50 g of it in the batter.

CIQUAL publishes NO energy for granulated sugar or for baking powder.
The generator derives those with the app's OWN Atwater factors
(`KCAL_PER_G` / `KCAL_PER_G_FIBER_NET` in `src/lib/nutrition.ts`: 9 kcal/g
fat + 4 kcal/g protein + 4 kcal/g digestible carbohydrate + 2 kcal/g net
fibre) and records `energy_source: "atwater"` on the row, so a derived
number is never dressed up as a published one. The generator refuses to
write an energy it can neither read nor derive.

The XML is **windows-1252 and not well-formed** (a raw `<` inside
`ALIM_NOM_INDEX_FR` for "Panaché préemballé (<1° alc.)") and `compo` is
57 MB, so the parser is a tolerant block/tag scanner, not `ElementTree`.
The `teneur` grammar is handled explicitly: comma decimals (`56,5`),
`< 0,1` limits (the published bound is substituted and the row is marked
`below_limit`, so the emitted value is an upper bound), `-` and
self-closing tags as ABSENT, and a real `0` kept as a real zero (salt is
0 kcal, not "unknown").

`--check` is the offline gate, run by `bun run data:verify`: it
recomputes every user recipe's nutrition block from the COMMITTED table
and fails the build on any drift — which is what makes "never
fabricated" enforceable on every push, with no network. The download is
a deliberate, separate step (`bun run data:nutrition:download`, owner
only); a committed artifact must be reproducible offline.

`scripts/test_build_ciqual_nutrition.py` is the golden suite: the parse
grammar, the nutrient code map against the app's `NUTRITION_UNITS`
(parsed out of the TS at test time), the sugar-basis rule, the
per-food-attributed D exception, the pancake's kcal against a
hand-computed total (3 052.22 kcal over the batter → 381.53 per
serving), and the refusal paths.

The pancake's own numbers are authored by
`scripts/add_user_recipe_pancake.py`, which calls the generator's
`recipe_nutrition()` — the doc's `nutrition` block, `meta.calories`,
`meta.sodium_mg` and `meta.macros` are all the ONE derived per-serving
computation (8 servings), so they cannot disagree with each other or
with the table.

## Consequences

* **Every engine works on user recipes** with no per-engine code: search,
  diets, Auto-Plan, grocery, Shop, cooking, favourites, ratings, rooms.
* **The catalog count is no longer constant.** `mealTypeCount(-5)` and the
  e2e "N recipes" strings are re-pinned, and `src/lib/mealTypeFilter.test.ts`
  moves with them. The warnings in the two generators are now genuinely
  load-bearing: a mismatch means a generator was not re-run.
* **A user recipe is a first-class peer in the plan.** It can be planned
  beside a Mealime dinner, its ingredients merge into the same grocery
  lines, and its rating is household state like any other (ADR-0031).
* **Nutrition for a user recipe is a sum of per-100 g compositions**, so
  it inherits the table's uncertainty (CIQUAL publishes a confidence code
  per value; the row keeps it), and it will NOT match Mealime's numbers
  exactly — different food definitions, different lab methods, and
  ~±10% on kcal is the honest expectation. It is derived and
  reproducible, which is the bar — not restaurant-grade.
* **A user_recipes.json that is invalid is not fatal**, it is a build
  with no user recipes; the loader reports it once and the catalog still
  loads.
* **Accuracy is stated, never claimed.** Wherever the numbers are shown
  (the brief, the report, the skill), the honest statement is: derived
  from CIQUAL 2020 by the app's published conventions, expect roughly
  ±10% on kcal, do not claim Mealime parity.

## Alternatives considered (continued)

* **Ship the CIQUAL table whole (3,185 foods, ~5 MB)** — rejected. It
  would triple the app's first payload to answer a question one authored
  recipe asks. The curated table plus its provenance is the same
  honesty at 1% of the bytes, and the generator is re-runnable when a
  recipe needs a food that is not in it yet.
* **Compute nutrition in the browser from the CIQUAL table** — rejected.
  It is a build-time fact about a frozen artifact, and the app has no
  reason to know ANSES exists at runtime.
* **A `source` filter plus a separate `newOnly` boolean** — rejected, per
  L1: a second, overlapping boolean is a state where the grid is empty
  for a reason no control can explain.
* **Keeping `proOnly` alongside `source` for a release** — rejected. The
  persisted type carries one spelling; the compatibility branch lives in
  `normalizeQuickFilters`, which is where every other inbound coercion
  already lives.
