# ADR-0043 — meal-type filter dropdown with icons

* Extends: ADR-0027 (unified quick filters)
* Status: **Accepted** (as built — see the as-built notes in Consequences)
* Companions: `scripts/extract_recipe_types.py`, `scripts/test_extract_recipe_types.py`,
  `public/data/recipe_types.json`, `src/lib/mealTypeFilter.ts`, `src/components/RecipesTab.vue`

## Context
The owner wants to filter the Recipes tab "by dinner, dessert etc" with nice
icons in a dropdown.

**The catalog already carries the answer.** `variant_meta[].ruleset` is a
meal-occasion field with six values — `dinner` (2 119), `simple` (304),
`breakfast` (151), `dessert` (91), `snack` (89), `cpg` (5). It is the *same*
field the Mealime app filters on: its "151 breakfast recipes" is exactly this
count, which is how the taxonomy was identified.

An earlier draft of this ADR claimed the catalog had no occasion field and
proposed a keyword lens over recipe names. That was wrong: the lens was built,
counted 104 breakfasts against the app's 151, and discarded once
`ruleset` was found. The lesson is recorded in §Non-goals.

## Decision
A single **`Meal type`** dropdown in the Recipes filter bar (2-col phone grid,
ADR-0027 placement) offering the five meal buckets, each with a bundled Lucide
icon, fed entirely by a **build-time-committed JSON table** — the client does
no 2 759-recipe scan at runtime (the owner's "no big parsing in the client" rule).

### The buckets (from `ruleset`, one per variant)
| id  | label     | icon           | `ruleset`  | count |
|-----|-----------|----------------|------------|-------|
| -1  | Breakfast | Sunrise        | `breakfast`| 151   |
| -2  | Dessert   | IceCreamCone   | `dessert`  | 91    |
| -3  | Snack     | Cookie         | `snack`    | 89    |
| -4  | Simple    | Gauge          | `simple`   | 304   |
| -5  | Dinner    | UtensilsCrossed| `dinner`   | 2 119 |
| -6  | Branded   | Tag            | `cpg`      | 5     |

- **`cpg` is counted but NOT offered.** It is Mealime's cost-per-gram
  product-placement bucket (branded OIKOS/PHILADELPHIA recipes), not a meal
  anyone plans around. It is emitted with `offered: false` so the partition
  invariant still holds over the whole catalog.
- Ids are **negative** so an occasion can never collide with a positive
  catalog variant id.
- The taxonomy is Mealime's, not ours: `Dinner` legitimately covers lunches
  too (there is no `lunch` ruleset). "Simple" is Mealime's quick-easy bucket.

### Build-time count, static import
`scripts/extract_recipe_types.py` makes ONE pass over `variant_meta`, tallies
`ruleset`, and writes `public/data/recipe_types.json`
(`{byId, order, total, unmatched}`). The client imports that JSON statically
(Vite inlines it, the `ingredients.json` precedent in
`ingredientSuggestions.ts`), so the dropdown's counts cost one small module.

The FACET itself is an **exact string compare** against `meta.ruleset`, which
is already in the loaded catalog — no fetch, no regex, no memo table, and
unlike ADR-0018's diet lens this filter is *exact*, not a suggestion.

### Filtering contract
- `QuickFilters` (+1 member): `mealType: number | null` (`null` = Any,
  default). Persisted via the existing store watcher; shared as household
  state like the rest of `QuickFilters` (ADR-0027 §4).
- `normalizeQuickFilters` validates: `MEAL_TYPE_IDS.includes(v.mealType)`,
  else `null` — the same drop-unknown rule as diets.
- Facet clause in `RecipesTab.results`: `f.mealType === null ? true :
  MEAL_TYPE_BY_ID.get(f.mealType) === meta.ruleset`. O(1), no allocation.

### Surface (mirrors the sort-menu listbox, ADR-0027)
- Trigger `data-test="mealtype-button"`, `aria-haspopup="listbox"`,
  `aria-expanded`, `aria-label="Meal type"`; shows `icon + label` of the
  active type, or `Sparkles + Any` when `null`.
- Menu `data-test="mealtype-menu"`, `role="listbox"`, options
  `data-test="mealtype-option-{label}"` (Breakfast/Dessert/Snack/Simple/Dinner),
  each `role="option"` with icon + label + count, `aria-selected`.
- Keyboard: reuse the sort-menu handlers (Arrow/Home/End/Escape/Tab).
- Icon colour **neutral** (meal occasions carry no food hue; the selected
  option/chip uses the brand-tint rule, DESIGN.md "Selection and actions") —
  icons keep their colour in both states, pills never resize.
- `clearFilters()` resets `mealType` to `null`.

## Non-goals / hard NOs
- **No keyword lens over recipe names.** It was tried and discarded: it
  disagreed with the app (104 vs 151 breakfasts) and would have shipped a
  guess next to data that was already exact. If a future catalog drops
  `ruleset`, the goldens fail loudly instead of silently degrading to a guess.
- No dish-type chips — `variety_tag_ids` already backs the protein chips.
- No runtime scan of `variant_meta` for counts.
- No new store slice (no STORE_SLICES entry — a field on QuickFilters).
- No new colour token (neutral icons only); `palette.ts` untouched.
- No 6th bottom tab (ADR-0016 e2e-pinned).
- No runtime fetching of anything (offline-first): the committed JSON plus the
  `ruleset` already in the loaded catalog are all the filter needs.

## Verification
- `python3 scripts/extract_recipe_types.py [--check]` — `--check` fails on a
  stale committed artifact (for CI).
- `python3 scripts/test_extract_recipe_types.py` — 14 goldens: every variant
  carries `ruleset`, no unmapped value appeared, the buckets partition the
  feasible catalog, Breakfast == 151 (the app's own number), Dinner largest,
  no empty chips, `--check` idempotent.
- TS test: the `MEAL_TYPE_IDS`/label/icon registry agrees with the JSON
  (`src/lib/mealTypeFilter.test.ts` — partition, the 151/91/2119 counts,
  negative ids, exactness of the facet) and `quickFilters.test.ts` pins
  normalization (`-6` and junk both mean Any).
- e2e: `e2e/meal-type-filter.spec.ts` — the option counts agree with the
  SERVED catalog (read from `builder_data.json`, never a pinned literal);
  Dessert narrows to exactly the catalog's dessert count and Breakfast to
  151; Any restores the whole catalog; the selection persists across a
  reload and `Clear filters` resets it; the listbox keyboard contract holds
  and Escape returns focus to the trigger; a diet chip can only narrow
  further. Desktop Chrome + Pixel 7.

### As-built notes
1. **The listbox behaviour is shared, not copied.** The sort menu already
   had ~70 lines of focus bookkeeping (arrows, Home/End, Escape + refocus,
   Tab, click-away, one document listener per menu). A second popup
   hand-written the same way is how the two would drift — one with a focus
   bug, one without a click-away — so it lives once in
   `src/composables/useListboxMenu.ts`, parameterised by option count and
   "which option is selected". The sort menu's own contract specs
   (`quick-filters.spec.ts`, WS1/WS3/WS4) pass unchanged, which is the
   evidence the extraction changed no behaviour.
2. **"Any" is option 0 of the listbox**, not a separate control, so the
   listbox count is `offered buckets + 1` and the initial focus lands on
   the active row. Clearing a filter is the most common trip here.
3. **Counts render raw** ("2119", not "2,119"): the Recipes tab already
   renders `results.length` unformatted, and a second number format in the
   same paragraph would be the inconsistency.
