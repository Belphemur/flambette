# ADR-0012: Ingredient index + grocery add-item autocomplete is offline data with device-local memory

Date: 2026-09-28 · Status: Accepted

## Context

The grocery add-item form was a dumb text box: no suggestions, help, or
structure — users typed free-form names that landed in the "Extra items"
section. The frozen catalog (2,730 recipes, 34,415 line items) contains
only 349 distinct ingredient display names (338 distinct `nameKey`s), which
is enough to suggest from, but the recipe docs carry NO store-section data
(ADR-0001: bucketing is a keyword heuristic — `src/lib/sections.ts`).

Two separate needs emerged:

1. Smarter typing — suggest real ingredient names with their store
   category while the user types.
2. Memory — a name typed once should be easier to type again.

## Decision

### 1. The ingredient index is baked offline data (same class as the catalog)

`scripts/extract_ingredients.py` (stdlib only, no network, idempotent)
walks `public/data/recipes/*.json` and emits
`public/data/ingredients.json`: one row per distinct nameKey —
`{name, nameKey, category, unit}` — sorted alphabetically, plus
`generatedAt` and `count`.

- **nameKey/unitKey/category mirrors**: the extractor ports
  `nameKey()`/`unitKey()` from `src/lib/grocery.ts` and `bucketFor()`
  from `src/lib/sections.ts`, then majority-votes category and unit per
  nameKey across recipes. Matching merges exactly like grocery
  aggregation. If either side changes, re-run the extractor and commit
  the JSON.
- **Authoritative snapshot override**: the 17 ingredients of the bundled
  `user_data.json` current_meal_plan snapshot carry real Mealime
  `section_id`s; where a snapshot nameKey matches a catalog nameKey
  (16 do), the real section wins over the heuristic.
- **Units** are majority-normalized (`unitKey`) with the first-seen
  spelling kept for display; unparseable quantities ("3 (398 ml) cans")
  contribute no unit — mirroring the app, which passes them verbatim.
- The JSON is loaded **lazily** in the app (`import()` once, service-side
  chunk, ~5 kB gzip) — no runtime fetch, no mealime.com traffic.

Re-run: `python3 scripts/extract_ingredients.py` from the repo root.

### 2. Suggestion ranking is a fixed 3-tier rule

`src/lib/ingredientSuggestions.ts` (cap 8, index before custom):

1. `nameKey.startsWith(query)` — typed-prefix match
2. word-boundary match — `\bquery` in the nameKey
3. substring match

Within a tier: alphabetical by display name (stable). Custom remembered
names get the same 3-tier ranking but merge into their own lower group so
the index always wins ties. Modelled on the nameKey, so "carrots" and
"carrot" hit the same entry.

### 3. Unknown names stay addable and remembered — device-locally

Enter always submits the raw typed text. Typed names persist in a NEW
store, `src/stores/customIngredients.ts`
(`mealime-planner:v1:customIngredients`, cap 500, dedupe by nameKey,
newest kept) — separate from `plan.customItems`. Suggestion rows from
this store carry a subtle "mine" badge.

**Boundary reaffirmed: this memory is DEVICE-LOCAL convenience state and
must stay OUT of the room payload.** Room state remains
`{plan, customItems, checked, cleared}` (ADR-0006) — one household
member's typed history is not household data; a room join or share
(`/plan?p=` or room join) MUST NOT resurrect it. The chosen category for
a free-form item lives in this memory, not on the room-synced
`customItems: string[]` rows — that shape is unchanged on purpose.

### 4. Category choice is optional, defaulted, remembered

`IngredientAutocomplete.vue` adds a category dropdown next to the input.

- Picking an index suggestion pre-fills the category from the index.
- A free-form add defaults to "Other" unless overridden before submit.
- The override is remembered in `customIngredients` and shown as a chip
  on the added custom row (`data-test=custom-item-category`); for names
  that also exist in the index, the index row wins the suggestion
  ranking (dedup by nameKey) — the remembered override still surfaces on
  the row chip.
- a11y: combobox/listbox semantics (`role=combobox`,
  `aria-expanded`, `role=option`, `aria-activedescendant`), keyboard
  ArrowUp/Down + Enter (pick) / Enter (no pick → raw submit) + Escape
  (close), `aria-label` on every interactive element.

## Consequences

- `public/data/ingredients.json` is a committed build input: the
  extractor (NOT runtime code) is the living part of the pipeline —
  catalog updates re-run the extractor; the JSON diff is reviewable.
- The baked JSON is generated data: sweep it for scrub-target strings
  before pushing (it contains only ingredient names/units from the
  frozen catalog).
- The suggestion list is capped at 8 and driven by the frozen catalog —
  no runtime request, honoring the offline rule.
- `plan.customItems` (room-synced) remains string-only; category
  enrichment never leaks into shared state.


## Boundary change (2026-09-27, owner decision): remembered names are household

Originally the remembered-names memory was DEVICE-LOCAL state, explicitly
left out of room sync ("one household member's typed history is not
household data"). Policy CHANGED on 2026-09-27: `customIngredients` is
HOUSEHOLD state. The room payload is now
`{plan, customItems, checked, cleared, customs}`; applyRemote is tolerant
of missing `customs` on old payloads (no wipe-to-empty). The push watcher
covers list changes. Personal cookedHistory remains room-excluded (see
ADR-0011 addendum for its opt-in sharing). Backups (ADR-0013) carry both
slices regardless — the backup is the user's own archive.
