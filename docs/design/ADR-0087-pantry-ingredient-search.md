# ADR-0087: "Cook with what I have" — pantry ingredient search, Variant A inline row

Status: accepted (2026-10-14) — implemented in PR #90

Implements issue #80 ("Search recipes by ingredients on hand"). The number
0087 was taken via `scripts/build_adr_index.py --next` on a fresh
origin/main checkout after a whole-remote-branch reservation scan
(global max was ADR-0086).

## Context

The r/mealime shutdown thread repeatedly names "searching recipes based on
ingredients you have" as the competitor feature Flambette lacks. The ask:
filter the catalog by ingredients the household already has, ranked by how
few extra items a recipe needs — kept as a Recipes-tab filter, NOT a
planner feature (the pack planner stays waste-first over the eligible
slice).

The substrate already exists; nothing new is scraped or fetched:

- `public/data/ingredients.json` — the ingredient index (ADR-0012),
  871 entries with `name`/`nameKey`/`category`.
- The pre-built search index tokenizes `variant_meta.ingredient_names`
  into the MiniSearch `ingredients` field (ADR-0060, recipe search query
  language).
- `RecipeSearchField` (ADR-0064, header placement ADR-0070), the
  quick-filter bar (diet chips ADR-0018, unified ADR-0027) and
  `IngredientAutocomplete` + `ingredientSuggestions.ts` (ADR-0012)
  already live on the tab.

### Design authority

Google Stitch project **2725470430841257407** ("Flambette Recipe App",
Warm Culinary Paper theme). Three variants of the Recipes screens were
generated (REFINE, aspects LAYOUT+TEXT_CONTENT) and the owner picked
**Variant A** in chat:

- **Adopted (desktop):** screen `Flambette — Recipes (Cook With What I
  Have: Variant A - Inline Filter Row)` — the owner-supplied full HTML
  export of this render was reviewed element by element.
- **Adopted (mobile):** screen `Flambette — Recipes (Cook With What I
  Have: Mobile Variant A - Inline Filter Row)` — its full HTML export
  was reviewed element by element as well.
- **Recorded alternatives (not adopted):** desktop/mobile
  `… Variant B - Dedicated Pantry Panel` and
  `… Variant C - Query Operator Search` — named here so a later session
  can re-find them without hunting the canvas.

Render = visual authority; this ADR = behavioural authority; DESIGN.md =
tokens. Where the render and the repo disagree, the repo wins and the
divergence is listed under Rejected elements.

## Decision

1. **Entry point: an inline "In my kitchen" chip row** in the Recipes
   tab filter area, a sibling of the existing quick-filter chip rows
   (inside the `data-test="filter-bar"` anatomy). Not a new tab, not a
   planner surface. With zero pantry ingredients the row collapses to
   just the add affordance, so default browse is byte-identical in
   behaviour and visual weight to today's tab.
2. **Row contents:** selected pantry ingredients as removable chips,
   an add input with autocomplete over the ingredient index plus the
   household's "mine" custom ingredients, a count label
   (`In my kitchen (N)`) and a `Clear ingredients` action.
3. **Ingredient identity is `nameKey`** — the same merge key grocery
   aggregation already uses (ADR-0012). Pantry membership matches
   `variant_meta.ingredient_names` through nameKey; there is exactly one
   identity rule in the app for ingredients and this feature does not
   add a second one (DRY).
4. **Behaviour:** with ≥1 pantry ingredient the grid filters to recipes
   sharing at least one pantry ingredient, ranked ascending by MISSING
   count (pantry ingredients the recipe does not use); ties fall through
   to the currently selected sort comparator. With an empty pantry the
   grid is the normal browse. The ranking and the badge derivation live
   in ONE pure lib (new `src/lib/pantry.ts`) consumed by both
   `RecipesTab` and `RecipeCard` — no component-local copies, unit pins
   in `src/lib/pantry.test.ts` (DRY over SOLID over KISS).
5. **No new SortBy option.** The render shows a "Fewest Missing" entry
   in the sort dropdown; deliberately NOT adopted. Ordering is owned by
   the pantry feature itself while the row is active (implicit ranking,
   Decision 4) — a second ordering knob in the dropdown would create two
   sources of truth for "what order is the grid in" and could fight the
   selected comparator. The real sort set stays
   Top rated / Latest / Most popular / Quickest / Fewest calories.
6. **Card badge grammar** (derived only from real data): when the pantry
   row is active each card shows a have/needs badge built from ONE pure
   data shape ({have, total, missing[], ready}) produced by the lib of
   Decision 4; presentation adapts per breakpoint from the same shape
   (no second computation):
   - desktop: `You have N of M` + `Needs 1 more: <first missing
     ingredient>` or `Needs K more` (K > 1 lists no ingredients — the
     detail page already carries the full list);
   - mobile (compact): `N of M • Needs 1` / `N of M • Needs K`;
   - N = M renders the have-it-all state — the render's
     `Ready (4 of 4)` with the check glyph, i.e. `Ready (N of N)`.
   The badge is `data-test="pantry-badge"` and renders ONLY while the
   pantry row is active.
6b. **Results summary is adopted, in real-data form.** The mobile
   render's summary line (`Cook With Your Pantry · 8 recipes · Matched
   with …`) becomes an extension of the grid header that already exists:
   while the pantry row is active it names the count of matching recipes
   and an `aria-live="polite"` status carries the same text, so re-ranks
   are announced. The counts are computed from the actual filtered set,
   never hardcoded.
7. **Persistence: device-local, not room-synced.** A new Pinia slice
   holds the pantry nameKeys, registered in the `STORE_SLICES` backup
   registry in the SAME change (ADR-0013; the e2e registry-coverage case
   fails any slice that skips registration). It stays OUT of the
   room-sync payload — same ruling as custom ingredients (ADR-0012:
   device-local convenience state). A shared household pantry would be a
   deliberate payload extension, deferred, not smuggled in here.
8. **Suggestion machinery is reused, not forked.** The pantry add input
   gets its suggestions from `ingredientSuggestions.ts` (the one
   suggestion source of truth) and reuses `IngredientAutocomplete`'s
   keyboard model (ArrowUp/Down, Enter, Escape) — whether by direct
   component reuse or a thin prop-driven variant is the implementer's
   call; duplicating the suggestion logic is forbidden (DRY).
9. **Suggestion categories are real:** they come from
   `ingredients.json`'s `category` field (e.g. "Dairy, Cheese & Eggs",
   "Produce"), never invented buckets.
10. **Accessibility + hooks:** chips are buttons with
    `aria-label="Remove <name> from my kitchen"`; the add input is
    labelled (`aria-label="Add an ingredient you have"`); after a chip
    removal focus returns to the add input. Hooks:
    `data-test="pantry-row"`, `pantry-chip-<nameKey>`, `pantry-add`,
    `pantry-clear`, `pantry-badge`.

### Rejected render elements (fictions the app must not copy)

- **"Pantry Index • Vol. IV" / "Seasonal Archive" heading** — not app
  vocabulary; the Recipes tab keeps its real header.
- **"Smart Kitchen Matching Active" banner + `Manage Pantry` /
  `Plan Week` buttons** and the mobile render's **"Smart pantry
  prioritization" chip** — duplicated state narration; the active row
  itself communicates the state (KISS), and a second pantry-management
  surface would fork the row's editing model.
- **The mobile render's `Pantry Match` dropdown** — a second filter
  control mirroring the same pantry state the chip row already owns;
  two editors for one state is a DRY loss (the row IS the control).
- **Fabricated counts** ("showing 3" over 8 visible cards) — all counts
  derive from real results.
- **"ready to cook 15m"** — not a real metadata field.
- **Invented suggestion categories** ("Staple", "Pantry", "Herb") —
  real categories come from `ingredients.json` (Decision 9).
- **kcal on recipe cards** (desktop `620 kcal`, mobile `620k`) —
  `RecipeCard` carries no calories today; adding them is a separate
  concern, not this feature.
- **"Favorites" bottom tab** — the real tab set is
  Recipes / Plan / Grocery / History / Settings (ADR-0016; the fit is
  e2e-pinned and a 6th tab needs a re-measure).

## Consequences

- The competitor-named feature lands entirely on existing substrate —
  no new data pipeline, no runtime requests, offline-first preserved.
- Ranking cost is one `Set` intersection per recipe per pantry change
  (2,759 recipes × ≤N pantry chips) inside a `computed` — negligible,
  but it MUST live behind the single pure lib so the tab and the card
  cannot drift.
- The backup/export surface grows by one registered slice; the registry
  and its e2e case keep export/import/validation honest.
- Pantry is per-device until a deliberate room-payload extension; the
  deferred shared-pantry case is recorded here so its absence is a
  decision, not an oversight.

## Alternatives considered

- **Variant B — dedicated pantry panel** (Stitch screens recorded
  above): a prominent mode toggle swapping the top area into a pantry
  panel with a results summary line. Richer entry surface, but it hides
  the feature behind a mode and duplicates the filter bar's role for the
  same knowledge. Rejected (KISS): the inline row achieves the same flow
  without a second mode state.
- **Variant C — `ingredient:` query operator** (Stitch screens recorded
  above): power-user-only, and ranking-by-missing cannot be expressed in
  the grammar without heavy card augmentation. Rejected on
  discoverability for the persona that asked for the feature (the
  8-year workflow user); the query language may gain `ingredient:` in a
  later additive ADR if a power-user ask appears.
- **Planner integration** (waste-first re-rank over the pantry slice):
  explicitly out of scope per issue #80 — the pack planner stays
  waste-first over the eligible slice; mixing the two orderings would
  blur both.
