# ADR-0027: One quick-filter object, one filter surface, no orphan controls

**Status:** Accepted (2026-09-29)
**Extends:** ADR-0018 (diet chips), ADR-0013 (backup registry). Changes the
Recipes-tab filter UI and the persisted `ui` slice's shape; ADR-0018's
keyword rules and verdicts are untouched.

## Context

Two defects, one root cause.

**The same concept had two controls.** The Recipes tab carried a select
labelled **"All diets"** whose options were the catalog's
`variant_data.category_name` values (`fish` / `meat` / `vegetarian`) —
protein slices, not diets — *and* a diet-chip row from ADR-0018. One
concept, two surfaces, two different words for it, and a user who
reasoned about "diets" in the app's own words could not tell which
control did what.

**The sort control wrapped to a line of its own** on a Pixel-class
viewport (~390px). The filter row was `flex flex-wrap` and the sort
select carried `ml-auto`. Once the row was full, `ml-auto` could not fit
and the select became the first item of a new line — the owner's
screenshot symptom.

Underneath, the state was scattered: a local `ref` per control
(`category`, `maxTime`, `favOnly`, `proOnly`, `sortBy`) except the diet
chips, which lived in the persisted `ui` store. Nothing else persisted
and nothing synced, so a reload lost the sort order and the two phones
browsed different slices of the catalog.

## Decision

1. **`src/lib/quickFilters.ts` owns one plain object.** `{ diets,
   protein, maxTime, sortBy, favOnly, proOnly }` is the single source of
   truth for the whole filter surface. Pure, no Vue/Pinia, unit-tested,
   with a `normalizeQuickFilters` that repairs untrusted input (unknown
   diet ids dropped, out-of-range enums defaulted) and returns `null` for
   something that is not a filter object at all.
2. **One surface.** The "All diets" select is deleted. Protein values
   become the first chip group of the `data-test="quick-filters"` row and
   the ADR-0018 diet chips follow in the same row, each keeping its
   existing `data-test="diet-chip-…"` hook. Counts stay in the diet chip
   labels; the diet chips keep their `aria-label` descriptions.
3. **The search box is NOT part of the object.** A search is a question,
   not a household preference; it stays a device-local ref.
4. **The control row is a 2-column grid on phones** (`grid-cols-2`) and a
   wrapping flex row from `sm` up. Grid cells cannot orphan a control on
   a line of its own, so the wrap cannot come back with a longer label.
   This is deliberately not "we removed the dropdown so it fits" —
   free space is not a layout guarantee.
5. **Sort is a compact icon+label button opening a listbox**, not a
   native select. A native select's width is driven by its longest
   option ("Sort: Most popular"), which is what made the row overflow in
   the first place.
6. **Persisted in the existing `mealime-planner:v1:ui` slice** — no new
   store, so `STORE_SLICES` already covers it (ADR-0013); `settings.json`
   gained a `quickFilters` member with validation and import support.
7. **Backward compatible in both directions.** A pre-existing blob
   (`dietFilters`, no `quickFilters`) is migrated on hydration via
   `migrateLegacyUiFilters`; a pre-ADR-0027 backup still restores its
   diet chips; the export mirrors `dietFilters` so an older install
   restoring our backup does not lose them.

## Consequences

- One `data-test="filter-bar"` row, one `quick-filters` group, one
  `diet-filters` sub-group: the e2e hooks stay stable, and the specs
  that used them needed no changes.
- The filter selection now travels in the room payload — see ADR-0028.
- A partial word: "protein" replaces "category" as the user-facing word
  for those three values, because "diet" was wrong for all of them
  (`vegetarian` exists as BOTH a protein slice and a diet rule, and the
  two are computed by completely different code paths — `category_name`
  versus the ADR-0018 keyword classifier).
- `clearFilters` resets the whole object, including the sort mode.

## Alternatives considered

- **Keep the dropdown, rename it "Protein".** Rejected: the owner asked
  for the duplicated control to go, and two chip groups with the same
  shape is a worse answer than one.
- **A horizontal scroll strip for the chips.** Rejected: it hides
  options behind a gesture on the exact viewport that reported the bug.
- **`ml-auto` on a shorter sort select.** Rejected: it makes the layout
  depend on label length, which is the bug.
