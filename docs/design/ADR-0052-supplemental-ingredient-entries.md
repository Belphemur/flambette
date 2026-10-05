# ADR-0052 — supplemental ingredient entries (gluten-free / lactose-free / dairy-free)

* Extends: ADR-0012 (ingredient autocomplete index), ADR-0014 (immediate-add)
* Status: **Accepted** (as built — see the as-built notes)
* Companions: `scripts/extract_ingredients.py` (`SUPPLEMENTAL`),
  `scripts/test_extract_ingredients.py`, `public/data/ingredients.json`,
  `e2e/grocery-autocomplete.spec.ts`

## Context

The grocery add-item autocomplete is backed by `public/data/ingredients.json`,
built by `scripts/extract_ingredients.py`. Until now that build was a pure
census: it walks the 2 759 recipe docs and emits one row per distinct
ingredient nameKey. It reported **338 ingredients**.

That number reads large but is narrow in a way that makes it useless for the
case the owner hit. The index can only ever name an ingredient **some Mealime
recipe already buys**, so the moment a household swaps something out there is
nothing to type. Census over all 2 759 docs, 349 distinct raw spellings:

| probe | docs naming it |
|---|---|
| `gluten` (any form) | **0** |
| `lactose` | **0** |
| `dairy-free` | **0** |
| `oat milk` / `soy milk` | **0** |
| `xanthan`, `psyllium`, `tapioca` | **0** |
| `bouillon`, `stock` | **0** |
| `amaranth`, `cream of tartar`, `ghee`, `agave`, `molasses` | **0** |

The catalog has no dietary metadata at all (this is the ADR-0018 premise:
diet chips are a keyword *heuristic* precisely because the data does not
describe diet). So the diet a recipe implies is inferable, but a
**purchaseable substitute for one of its ingredients is not in the data at
all** — there is no "instead of this, buy that" dimension to derive. Deriving
one is not possible; it has to be authored.

Adding variants was considered and rejected: the catalog is frozen
(ADR-0001, `sync_catalog.py` is the only way it grows), and a GF variant of a
recipe is a *new recipe*, which is the opposite of the small ask.

## Decision

Add a hand-authored **`SUPPLEMENTAL` table** to `extract_ingredients.py`,
merged into the index after the catalog walk. **+264 rows: 338 → 602.**

The table is grouped by what it fixes:

- **Gluten-free** (31 rows) — all-purpose/bread/cake/whole-wheat/oat/rice
  flours, flour blends, xanthan & guar gum, psyllium, tapioca & potato
  starch, bread, breadcrumbs + panko, pita, tortilla, bagel, bun, English
  muffin, naan, pizza crust, croutons, pasta/spaghetti/penne/orzo, lasagna,
  rice & egg noodles, soy sauce, tamari, rolled oats, cereal, beer.
- **Lactose-free** (13 rows) — milk, half-and-half, butter, cream, sour
  cream, cheese, cheddar, mozzarella, yogurt, Greek yogurt, cottage cheese,
  cream cheese, ice cream.
- **Dairy-free** (13 rows) — the same ladder, plus chocolate; plus
  plant-based cream cheese and butter.
- **Plant milks** (6 rows) — oat, soy, almond, cashew, pea, coconut beverage.
- **Vegan equivalents** (8 rows) — coconut yogurt/cream, vegan butter, cheese,
  cream, sour cream, chocolate, coconut aminos, nutritional yeast.
- **Pantry the recipes never name** — 9 stocks/bouillons, cooking fats,
  sweeteners (agave, date syrup, molasses, corn syrup), chocolate & extracts,
  international condiments (ponzu, gochujang, harissa, sriracha, yuba, chili
  crisp), extra grains/beans/seeds/nuts/butters, produce, eggs/dairy basics,
  meat/seafood cuts, spices/salts, drinks.

### The rule that makes the table safe: a row is a FILLER, never an override

Merge precedence is **snapshot override > catalog majority vote > SUPPLEMENTAL
row**, and a supplemental row whose nameKey the catalog already produces is
**skipped**.

That is the load-bearing property. The catalog stays authoritative for
everything it knows: no hand-authored row can overwrite a real recipe's
observed category or unit, so this change cannot silently re-file an
ingredient a household already shops. The table only ever fills a gap.

This also settles what happens when the catalog catches up. If a future
`sync_catalog.py` run brings in real gluten-free recipes, those nameKeys land
as CATALOG rows, the supplemental duplicates get skipped, and
`test_extract_ingredients.py` fails loudly on
`test_no_row_shadows_a_catalog_ingredient` — the signal to *shrink* the table
rather than let it quietly shadow real data. 36 rows were pruned during
authoring for exactly this reason (`cornstarch`, `baking powder`, `apple cider
vinegar`, `bacon`, `ground chicken`, … are already catalog ingredients).

### Categories are STATED, not inferred

`bucketFor()` (`src/lib/sections.ts`) is a first-match keyword lens tuned for
*authored recipe prose*, and it misreads shopping-list names:

| name | `bucketFor()` says | why | authored |
|---|---|---|---|
| gluten-free bread flour | Bakery | matches `bread` before `flour` | **Baking & Spices** |
| potato starch | Produce | matches `potato` | Baking & Spices |
| pea milk | Produce | matches `pea` | Dairy, Cheese & Eggs |
| cashew milk | Nuts, Seeds & Dried Fruit | matches `cashew` | Dairy, Cheese & Eggs |
| coconut milk beverage | Canned & Jarred Goods | matches `coconut milk` | Dairy, Cheese & Eggs |

So every row carries its `StoreSection` explicitly. The lens is left alone:
widening it for shopping vocabulary would move CATALOG ingredients around to
serve a different question, which is the wrong trade. A wrong section is worse
than no heuristic here — the category is what files the item into the store
aisle the user then walks.

**Plant milks file under `Dairy, Cheese & Eggs`, not `Beverages`.** They are
not drinks in this app's model; they substitute a *measured* milk the recipe
calls for, so they belong beside `whole milk`, which is where the shopper
looks.

### No invented units

Every supplemental row has `unit: null`. There is no observed quantity for an
ingredient no recipe uses, and the unit is only a hint on the suggestion row —
printing a fabricated `(1 L) cartons` would be advice the app cannot honour.
An absent hint is honest; a wrong one is worse.

## Non-goals / hard NOs

- **No new client code.** The index shape is unchanged
  (`{name, nameKey, category, unit}`); `ingredientSuggestions.ts`,
  `IngredientAutocomplete.vue` and `sections.ts` are untouched. This is a data
  change plus its gate.
- **No new store slice, no `STORE_SLICES` entry** — the artifact is a committed
  JSON, not persisted state.
- **No diet-tag inference on the substitutes.** These rows are *suggestions
  available to type*; nothing here asserts a recipe is gluten-free. That stays
  ADR-0018's explicitly-suggestion-lens territory.
- **No recipe rewriting.** A recipe that calls for butter still calls for
  butter; the grocery list is where the swap happens, and the user does it by
  typing the substitute. Adding "instead of" semantics to the plan is a
  different, much larger feature.
- **No runtime scanning, no new deps, no external fetches** (offline-first is
  e2e-enforced).

## Verification

- `bun run test:data` (new gate) — `scripts/test_extract_ingredients.py`,
  **13 goldens**: every row names a real `StoreSection`; no duplicate display
  names; no two rows share a nameKey; **no row shadows a catalog ingredient**;
  every row reaches the output; no row carries an invented unit; nameKeys
  unique + sorted; the dietary names are searchable; substitutes file beside
  what they substitute; the build is idempotent. Plus the census itself as a
  golden — `test_the_catalog_names_no_dietary_alternative_at_all` — which
  FAILS LOUDLY if a catalog refresh ever introduces `gluten`/`lactose`/
  `oat milk`, because that is the moment this table should shrink.
- `bun run build` — green (the index is a static import, inlined by Vite; the
  chunk is a lazily-imported 53 kB module, 7.6 kB gzipped, so it does not
  weigh on first paint).
- `bun run test:unit` — 513 pass, 0 fail.
- e2e `e2e/grocery-autocomplete.spec.ts` — new case asserts a GF flour
  surfaces with `Baking & Spices`, a lactose-free butter with
  `Dairy, Cheese & Eggs`, and that picking the latter files it as an extra
  under that section.
- Diff check on the artifact: **0 of the 338 catalog rows changed, 0 lost** —
  the direct evidence the filler rule held.

### As-built notes

1. **`nameKey` singularizes, so the searchable text and the stored key
   differ.** "gluten-free breadcrumbs" is stored under
   `gluten-free breadcrumb`. That is correct and load-bearing: it is what makes
   a grocery line for the item MERGE with the same thing typed in another form.
   The golden asserts on nameKeys, with the reason in a comment, so a future
   reader does not "fix" it into a display-name assertion.
2. **Near-duplicate display names are a real hazard, and only the golden
   catches them.** `gluten-free breadcrumbs` and `gluten-free bread crumbs`
   are one product and two distinct nameKeys, so `test_no_two_rows_share_a_
   namekey` does NOT flag them; a whitespace/punctuation-collapsing check did,
   during authoring. One row was dropped. Duplicates in the *index* would be
   harmless-ish, but two rows differing only in spacing is table rot.
3. **36 authored rows were pruned as already-present.** Pruning happens at
   authoring time, not silently at merge time: the golden then asserts the
   table is catalog-clean, so the file itself never carries a dead row.
4. **The data goldens are wired into the existing `unit` CI job** as
   `test:data` (with ADR-0043's recipe types and ADR-0041's timer hints, which
   previously ran only by hand). A hand-authored table is exactly the kind of
   thing `bun test` cannot see.