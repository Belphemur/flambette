# ADR-0052 — supplemental ingredient entries (gluten-free / lactose-free / dairy-free)

* Extends: ADR-0012 (ingredient autocomplete index), ADR-0014 (immediate-add)
* Status: **Accepted** (as built — see the as-built notes)
* Companions: `scripts/extract_ingredients.py` (`SUPPLEMENTAL`),
  `scripts/test_extract_ingredients.py`, `scripts/fetch_ciqual.py`,
  `public/data/ingredients.json`, `e2e/grocery-autocomplete.spec.ts`

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
merged into the index after the catalog walk. **+533 rows: 338 → 871.**

The table is authored in three tranches, each from a different gap-hunt
(§Authoring below): the dietary families, then an everyday-staple census, then
a CIQUAL diff. The families it covers:

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
- **Tranche 2, everyday staples (+168)** — found by censusing a hand-written
  ~450-name household shopping list against the built index and keeping only
  names with NO whole-word match in any existing key. That filter matters:
  a bare `fettuccine` is *not* a gap (`fettuccine pasta` is already there),
  and a naive substring diff would have added a duplicate row for ~130 of the
  450. Real gaps it closed: canned tomatoes/crushed tomatoes/corn/peas/
  carrots/mushrooms/artichoke hearts/jalapeños, pickles, kalamata olives,
  roasted red peppers, salsa verde, relishes, anchovy paste, 5 extra beans &
  lentils, 6 more cheeses (brie, camembert, gruyère, gouda, edam, provolone,
  parmigiano, romano, queso fresco, mascarpone), skyr, 2% and skim milk,
  salted/unsalted butter, crème fraîche, 12 meats (pork chops, pork loin,
  brisket, chuck roast, short ribs, veal, duck, meatballs, bratwurst, hot dog,
  chorizo, salami, pepperoni) and 9 seafoods (trout, catfish, sea bass,
  monkfish, prawns, squid, calamari, surimi), 22 produce items (green onions,
  iceberg/butter lettuce, cherry tomatoes, broccolini, delicata, rutabaga,
  jicama, rhubarb, endive, radicchio, microgreens, bamboo shoots, tarragon,
  4 hot peppers, 5 fruits), canola/sunflower/grapeseed oil, lard, shortening,
  8 whole spices (mustard, celery, caraway, fennel, nigella, fenugreek,
  saffron, sumac, za'atar), almond/pastry flour, semolina, 5 more pastas,
  arborio & sushi rice, oatmeal, grits, 12 nuts/dried fruits, 8 snacks,
  9 candies, 4 coffee forms, 6 drinks, 16 spirits/beers/wines.

- **Tranche 3, the CIQUAL diff (+102)** — the reference the owner asked for.
  `scripts/fetch_ciqual.py` pulls the ANSES **CIQUAL** food-composition table
  (English edition, Zenodo record 4770202, 3 186 foods) into
  `data/reference/ciqual_eng.xls` — a **gitignored, regeneration-only**
  artifact, never shipped and never read by the app. Diffing its English food
  names against the built index surfaced 102 genuine gaps, mostly in aisles
  the catalog is thinnest in: **12 more flours/starches** (rye, spelt,
  buckwheat, chickpea, soya, chestnut, barley, millet, maize, rice starch,
  self-raising), **17 more oils** (rapeseed, safflower, peanut, almond,
  hazelnut, poppyseed, linseed, rice bran, walnut, argan, cottonseed, corn,
  soy, palm, frying), raising agents & sugars (sodium bicarbonate, fructose,
  glucose, cane molasses, golden syrup, black treacle, cocoa butter,
  lecithin, gelling agent), 7 milks (semi-skimmed, goat, sheep, kefir, milk
  powder, processed cheese, soy cream), 11 juices, and smaller
  produce/grain/bakery additions (celeriac, chayote, escaroles, glasswort,
  longan, rambutan, horseradish, chervil, bran, oat bran, rice bran, rye,
  spelt, khorasan wheat, crispbread, rusk, rye crispbread, ice lolly, sorbet,
  frozen yogurt).

  **Most of CIQUAL was deliberately NOT taken.** It is a French table and a
  *dish* table, and the funnel shows it: **3 097 of its 3 186 names are absent
  from the index** (`--report` prints that raw review list), but after
  dropping names that describe a preparation rather than an ingredient — the
  `, raw` / `, cooked` / `, prepacked` / `from cow's milk` suffixes, and
  anything reading as a dish — only **563** remained, and hand-curating those
  yielded **102 rows**. The rejects are regional cheeses (Boulette d'Avesnes,
  Maroilles, Fourme de Montbrison, Brie de Meaux), charcuterie (chitterling
  sausage, coppa, bresaola, pâté), named spirits (Calvados, Marsala, pastis,
  Bénédictine) and prepared dishes (moussaka, paëlla, blinis, nougat, baked
  Alaska, beef carpaccio) — none of which is an item a household types into a
  shopping list. Which is why this tranche is **curated from a reference, not
  imported from it**: the script fetches and prints a checklist, the table is
  authored by hand. Provenance is a checklist, not a dependency.

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
vinegar`, `bacon`, `ground chicken`, … are already catalog ingredients). Tranche 2
was authored the same way — a candidate set of ~450 everyday names, filtered
to those with no whole-word match anywhere in the built index, which is what
separates a genuine gap from a naming variant (`fettuccine` vs the
already-present `fettuccine pasta`).

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
  **16 goldens**: every row names a real `StoreSection`; no duplicate display
  names; no two rows share a nameKey; **no row shadows a catalog ingredient**;
  every row reaches the output; no row carries an invented unit; nameKeys
  unique + sorted; the dietary names are searchable; substitutes file beside
  what they substitute; **every flour sits in one aisle**; **no inedible row
  reaches the index**; **`build()` is idempotent**; and **the committed index
  is not stale**. Plus the census itself as a golden —
  `test_the_catalog_names_no_dietary_alternative_at_all` — which FAILS LOUDLY
  if a catalog refresh ever introduces `gluten`/`lactose`/`oat milk`, because
  that is the moment this table should shrink.
- `python3 scripts/extract_ingredients.py --check` — script form of the
  staleness golden, run in CI beside the goldens. Exits 1 on a stale or
  missing artifact without writing to it.
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
- Negative tests: deleting a row from the committed artifact makes the
  goldens fail and `--check` exit 1, so the gate is proven able to fail
  rather than merely green.

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
3. **57 authored rows were pruned as already-present** (36 in tranche 1, the
   rest as later tranches exposed overlaps). Pruning happens at authoring
   time, not silently at merge time: the golden then asserts the table is
   catalog-clean, so the file itself never carries a dead row.
4. **The data goldens are wired into the existing `unit` CI job** as
   `test:data` (with ADR-0043's recipe types and ADR-0041's timer hints, which
   previously ran only by hand). A hand-authored table is exactly the kind of
   thing `bun test` cannot see.
5. **The table is authored in tranches, each from a different gap-hunt, and
   every count in this ADR is the SUM of them.** Tranche 1 (**263 rows**) was
   the dietary ask. Tranche 2 (**168 rows**) came from censusing a hand-written
   ~450-name household shopping list against the built index, keeping only names
   with no whole-word match in any existing key — that word-boundary rule is
   what stops "fettuccine" being called a gap when "fettuccine pasta" is
   already indexed (a naive substring diff would have added ~130 duplicate
   rows). Tranche 3 (**102 rows**) came from the CIQUAL diff below.
   **533 authored rows, 533 landed, 0 skipped** — every row is a real gap, so
   the filler rule dropped nothing. **338 → 871 in the artifact.** (Tranche 1
   is 263, not the 284 first committed: 21 rows were pruned against the
   catalog as later tranches exposed overlaps and the review below caught
   defects.)
6. **CIQUAL is a REVIEW LIST, never an import.**
   `scripts/fetch_ciqual.py` (gitignored output under `data/reference/`,
   `bun run data:ciqual`) fetches the ANSES table so the diff can be re-run
   rather than re-remembered, and prints which of its names the index lacks.
   Nothing consumes it: `extract_ingredients.py` does not import or shell out
   to it, and the curated rows are typed in by hand. The reason is that CIQUAL
   is a *French dish* table — most of its 3 186 names are regional cheeses
   (Boulette d'Avesnes, Maroilles), charcuterie (coppa, bresaola), named
   spirits (Calvados, pastis) or finished dishes (moussaka, paëlla), none of
   which a household types into a shopping list. An automated import would bury
   the ~65 real gaps under hundreds of wrong ones. The script is the checklist;
   the table is the decision. It is also the one script in `scripts/` that
   needs a non-stdlib dependency (`xlrd`, the source is legacy BIFF8), which
   is exactly why it is a `uv run` dev tool kept OUT of `test:data` — a golden
   must never need the network.
   Source: CIQUAL 2020 **English** edition via Zenodo record 4770202 (ODbL) —
   the newest English edition CIQUAL published as one spreadsheet; the live site
   has moved to a newer French edition served per-food-item with no bulk export.
7. **The goldens read the COMMITTED artifact; they never regenerate it.**
   The first cut of `TestIndexOutput.setUpClass` called `mod.main()` before
   reading the file, which meant a stale or truncated committed index was
   silently overwritten and the gate passed — the build and the release both
   consume the committed file, so that made the gate unfailable on the one
   thing it existed to check. Fixed: the goldens read the file as it sits, and
   a new `test_the_committed_index_is_not_stale` compares a fresh `build()`
   against it (content only — `generatedAt` is a fresh timestamp by design).
   `scripts/extract_ingredients.py --check` is the same assertion in script
   form and runs in CI beside the goldens. Verified by deleting a row from
   the committed artifact: the goldens then fail, and `--check` exits 1.
8. **PR review (Qodo) raised four findings; three were real and are fixed
   here, one was not.**
   - *silica gel in the baking aisle* — **real defect, fixed.** A packet
     desiccant is not food and was being offered to anyone typing "sil".
     Removed, with `test_no_inedible_row_reaches_the_index` pinning it.
   - *oat flour filed under grains while gluten-free oat flour sat in
     baking* — **real defect, fixed.** One product was shoppable in two
     aisles. Now `Baking & Spices`, with
     `test_every_flour_sits_in_one_aisle` making the whole flour family agree
     rather than patching the one name the reviewer happened to see.
   - *the goldens regenerate their own subject* — **real defect, fixed**, see
     note 7.
   - *"gluten-free whole wheat flour" is self-contradictory* — **not a
     defect.** It is a real retail product name (Bob's Red Mill, One Degree
     Organics and King Arthur Baking all sell it): a whole-wheat-flavoured
     blend made without wheat gluten. The shopper types the name off the
     packet, so the index must carry it; renaming it to "whole grain GF
     flour" would make the suggestion unsayable. The row stays, with a
     comment saying so, because this will be re-raised otherwise.