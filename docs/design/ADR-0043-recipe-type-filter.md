# ADR-0043 — recipe-type filter (dish types, with icons in a dropdown)

* Extends: ADR-0027 (unified quick filters)
* Status: **Proposed**
* Companions: `src/lib/mealTypeFilter.ts` (new), `src/lib/quickFilters.ts`,
  `src/components/RecipesTab.vue`, `src/lib/palette.ts` (no hue change)

## Context
The owner asked to "filter by dinner, dessert etc" with nice icons in a
dropdown. The catalog carries **no meal-occasion field** — this was verified
three ways (see §5): the baked recipe docs, the raw CDN recipe docs (2 730
files, identical 13-key shape), and `builder_data.json`. The only tagged
dimension is `variety_tags`/`variety_tag_ids` (int ids, unnamed) plus
`category_name` (already the protein chips). The Mealime app's own
"recipe type" filter (screenshot `Screenshot_20261001-182811..182826.png`)
lists **dish types** — Soup, Salad, Pasta, Burger, Curry … — which are
exactly these tag ids. So "dinner/dessert" was the owner's shorthand for the
dish-type filter; what they asked to see is this tag-derived dropdown with an
icon per option.

## Decision
Add a single-select **recipe-type** dropdown to the Recipes filter bar
(placed in the 2-col phone grid, beside cook-time), iconized like the sort
menu, reading from a frozen tag table in `src/lib/mealTypeFilter.ts`.

### Tag table `RECIPE_TYPE_TAGS: { id, label, icon, count }` (counts from the
### catalog; `public/data/recipes/<id>.timer.json` side does not change)
| id  | label                 | lucide icon   | count |
|----:|-----------------------|---------------|------:|
|  2  | Soup                  | Soup          |  201  |
| 20  | Salad                 | Salad         |  318  |
|  1  | Pasta & Pizza         | Pizza         |  250  |
|  4  | Burger & Sandwich     | Hamburger     |  163  |
| 33  | Pan-Fried & Crispy    | FryingPan     |  162  |
| 32  | Skillet & Braise      | Skillet       |  152  |
| 11  | Stir-Fry              | FryingPan     |  85  |
| 12  | Tacos & Quesadilla     | Taco          |  108  |
| 27  | Wraps & Fajitas       | Burrito       |  74  |
| 24  | Baked                 | Oven          |  280  |
| 25  | Bowls                 | BowlFood      |  127  |
| 26  | Stuffed               | Croissant     |  53  |
| 15  | Pork & Lamb Chops     | Beef          |  95  |
| 14  | Steak & Hearty Salads | Beef          |  110  |
| 22  | Grilled Protein       | Beef          |  134  |
|  6  | Curry                 | CookingPot    |   47  |
| 18  | Fried Rice & Noodles  | RiceBowl      |   49  |
| 29  | Noodle Squash         | Noodle        |   52  |
|  8  | Patties & Fritters    | Drumstick     |   45  |
|  7  | Frittata & Eggs       | EggFry        |   48  |
| 30  | Wings & Tenders       | Drumstick     |   40  |

Counts are derived from the baked `variant_data[].variety_tags` and
re-derived at build time by `scripts/` parity if exposed (out of scope here
— the table is static and committed; goldens pin nothing new but a
`data:verify`-style count check is invited as follow-up).

### Surface rules (mirrors the sort menu, ADR-0027 §2-col grid)
- Dropdown trigger: `data-test="mealtype-button"`, `aria-haspopup="listbox"`,
  `aria-expanded`, `aria-label="Recipe type"`; shows the icon + label of the
  selected type (or `Any` / Sparkles).
- Menu: `role="listbox"` of `role="option"` buttons, each `data-test=
  "mealtype-option-<id>"`, icon + label + count, `aria-selected`.
- Keyboard: arrow Home/End/Escape/Tab identical to `onSortMenuKeydown`.
- Icon hue is **neutral** (no food-role colour — these are dish categories,
  not diets). Selection paints the chip **tint** (brand-tint + brand outline,
  per DESIGN.md "Selection and actions"), never a fill — so the icon keeps
  its neutral colour in both states and the pill never resizes.
- Icons come from `lucide-vue-next` (bundled, ADR-0029); two tags share an
  icon (Steak/Grilled/Pork all → `Beef`; Skillet & Pan-Fried & Stir-Fry all
  → `FryingPan`/`Skillet`) — disambiguated by the label, never by colour.

### State (one member added to QuickFilters, ADR-0027 §4)
- New `mealType: number | null` (`null` = Any). Folded into the existing
  `QuickFilters` object, persisted in the `mealime-planner:v1:ui` slice by
  the existing store watcher — no new STORE_SLICES entry.
- `normalizeQuickFilters` validates it: `Number.isInteger(v.mealType)` and
  `RECIPE_TYPE_TAGS` contains it, else `null` (drops unknown ids, same rule
  as protein/maxTime).
- `toSharedFilters`/`mergeSharedFilters` carry it unchanged (household
  preference).
- Result pipeline: `facets` gains a clause — `f.mealType !== null &&
  !(meta.variety_tag_ids ?? []).includes(f.mealType)` → false. Memoized by
  `mealTypeIndexFor(catalog)` (parallel to `dietIndexFor`), so counts per tag
  come from the same pass.

## Non-goals
- No meal-occasion filter (dinner/lunch/breakfast) — the data does not
  distinguish them; the coarse `types` 1-8 on mealime.com overlap heavily
  and are not in the baked catalog anyway.
- No tag-name scraping at runtime (offline-first): the table is build-time.
- No new color tokens (neutral icons only); `palette.ts` untouched.

## Consequences
- `src/lib/mealTypeFilter.ts`: `RECIPE_TYPE_TAGS`, `MEAL_TYPE_IDS`,
  `mealTypeLabel(id)`, `mealTypeIcon(id)`, `mealTypeIndexFor(meta)`
  (memoized id→count), `normalizeMealType` guard — pure, bun-test.
- `quickFilters.ts`: +1 field + normalize line.
- `RecipesTab.vue`: add `mealtype-button` + listbox + icon map; wire
  `patchFilters({ mealType })`; clear-filters resets it; filter-bar grid
  gains one cell (2-col phone grid absorbs it per ADR-0027).
- `e2e`: new selectors `mealtype-button`, `mealtype-option-*` asserted.
