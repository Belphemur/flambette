# ADR-0050: Extra items are sub-sectioned by their own store category

* Extends: ADR-0015 (extras live in EXTRA ITEMS with a category tag),
  ADR-0008 (auto-collapse of grocery categories), ADR-0045 (one shared
  dropdown), ADR-0014 (bulk-add loop)
* **Supersedes, in part:** ADR-0015 §1 (the extras group is a static,
  non-collapsible scratch pad) and the third bullet of ADR-0015's
  "Alternatives considered" ("Make the extras group collapsible like the
  store sections — rejected…")
* Status: **Accepted** (2026-10-04)
* Companions: `src/lib/extraSections.ts` (new, pure),
  `src/components/GroceryTab.vue`, `src/components/IngredientAutocomplete.vue`,
  `e2e/grocery-extras-and-shop.spec.ts`, `e2e/bulk-add.spec.ts`

## Context

ADR-0015 (v0.9.0) made the extras group a deliberately flat thing. Its
own words:

> "Extras live in the EXTRA ITEMS static group. A free-form add is an
> 'Extra' and stays in that group: a plain header, no chevron, no
> collapse, no count-driven reordering."

and, rejecting this feature in writing:

> "**Make the extras group collapsible like the store sections** —
> rejected: it is a small static scratch pad; a chevron there implies a
> body of items that never appears."

The owner has now asked for exactly that, twice:

> "review the drop-down used there to be sure they use our new drop-downs"
> *(then, clarifying: "I mean for the categories drop-down")*, and the
> sub-sectioning ask: extras grouped into their own category sections
> (Produce, Dairy, …) with the same auto-collapse the real store
> sections already have.

**That is a legitimate reversal — the owner owns the decision — so this
ADR exists to record it rather than leave ADR-0015 standing as if it were
still accurate.** ADR-0015's file is untouched: it documents history, and
this ADR is what supersedes it, in the two places below.

### Why the old reasoning no longer holds

ADR-0015 rejected the chevron because "a chevron there implies a body of
items that never appears". That premise was true of the group HEADER: the
extras group is one flat `<ul>` under one static heading, so there is
nothing per-category to open or close. It is **no longer true of the
sub-sections**, because the sub-section body is defined by the category
the user (or the index match) attached to each extra. The store sections
already work exactly that way — a bucket with zero lines never renders —
so a sub-section with items genuinely has a body, and the chevron means
what it says.

The second change that makes this real: `customIngredients` already
remembers a **deliberate** store category per extra (ADR-0012, ADR-0014's
override dropdown), so a category is no longer only a text-derived guess
to be shown in passing — the user can pick one per add, and now wants to
see and act on it.

## Decision

1. **The sub-sections live INSIDE the extras group, and the group header
   stays.** `data-test="extra-section"` remains the single container,
   still FIRST on the Grocery tab, still with the add-row anchored
   directly under its header. The group header itself keeps its static
   shape (no chevron, no toggle) — what gains a toggle is each
   sub-section *below* it. `useGroceryList`'s `sections` computed is
   untouched: it is the derived recipe-driven engine, and extras never
   flow through it.
2. **A category is still a LABEL, never a move — ADR-0015 §2 SURVIVES
   INTACT.** An extra tagged `Produce` lives in the extras group's own
   `Produce` sub-section and MUST NOT appear in the recipe-derived
   `Produce` store section. The sub-section is a *view over the extras*,
   not a route into the store list. (Two e2e specs pin this.)
3. **`Uncategorized` is a real, named, collapsible sub-section (ADR-0015
   §3 is INVERTED).** An extra whose remembered category is missing,
   empty, or the `Other` bucket lands in `Uncategorized` instead of
   rendering as an unlabelled flat row. The owner wants the absence of a
   category *visible* and collapsible rather than silently flat. It sits
   **last**, after every real category, mirroring `STORE_SECTIONS` where
   `Other` is last.
4. **Sub-section order follows `STORE_SECTIONS`.** The canonical constant
   is reused; there is no second hard-coded copy of the category list in
   the component (the DRY failure ADR-0045 §1 calls out, which
   `AutoPlanDialog` already made once with the meal-type taxonomy). Only
   categories that actually have extras render — an empty `Produce`
   sub-section never appears just because `Produce` is in the constant.
5. **Auto-collapse is the SAME rule as the store sections (ADR-0008).**
   One implementation: the same done-map, the same
   false→true / true→false watcher, the same separate `manualCollapsed`
   set. Collapse state is keyed by a **namespaced** key, because extras
   have their own `Produce` sub-section and the store list has a real
   `Produce`: toggling the extras `Produce` must never collapse the store
   `Produce` (or any other pair). The namespace helpers
   (`extraCollapseKey` / `storeCollapseKey`, `src/lib/extraSections.ts`)
   are pure and unit-tested so the collision is structurally impossible
   rather than merely asserted.
6. **Sub-section headers match the store-section affordances.** Same `N/M`
   count pill, same chevron, same `aria-label` shape
   (`<Section>: X of Y checked`), same `aria-expanded`. A sub-section is
   collapsible by header click. The markup is shared with the store
   section header — one visual language, not two.
7. **The per-row category TAG is removed.** Once an extra sits under its
   own category sub-section, a `#Produce` pill on the row repeats the
   heading directly above it. This is a **visible, deliberate change**, not
   a silent one: the accessible information does not regress, because the
   sub-section heading (a real heading inside the group) carries the
   category and the group's structure reads as a labelled list of lists.
8. **The category override `<select>` becomes the shared
   `FilterDropdown`** (ADR-0045), consumed — not forked. `fullWidth: false`
   (a stacked full-width row under the input, the ADR-0046 §2.2
   precedent), options built from `STORE_SECTIONS` with the empty-value
   "Pick a store category" placeholder first so "no override yet" is
   still expressible. The override still resets after every add and a new
   keystroke still invalidates it — that behaviour is load-bearing for
   the ADR-0014 bulk-add loop.
9. **No new persisted slice.** Extras' categories already live in
   `customIngredients`, already registered in `src/lib/backup.ts`
   (`custom-ingredients.json`) and already covered by the registry
   assertion. This ADR adds a *view* over existing data; nothing is
   persisted, so `STORE_SLICES` is unchanged.
10. **Room sync is unchanged (ADR-0012), and the consequence is now
    visible.** `customIngredients` is deliberately device-local and OUT of
    the shared payload. Extras' sub-sections therefore come from the
    *reading device's* memory: a second household member may see the same
    shared extras under different sub-sections, or all under
    `Uncategorized`. This is pre-existing behaviour (the tag showed the
    same asymmetry), but sub-sections make it structural, so it is
    recorded here rather than left for someone to discover.
11. **ShopView is OUT OF SCOPE for auto-collapse (ADR-0008 addendum).**
    ShopView's extras group stays manual-collapse-only; a one-item extra
    must not auto-hide mid-trip. The owner's ask is about the Grocery
    tab's list UX.

## Selectors (data-test)

* `extra-section` — the group container, unchanged (ADR-0015).
* `extra-subsection` — one category sub-section inside the group.
* `extra-subsection-toggle` — its collapsible header button.
* `extra-subsection-rows` — its `<ul>` (mirrors `grocery-section-rows`).
* `extra-row` — the row itself, unchanged.
* `section-count-pill` — the shared `N/M` pill, reused.
* `extra-item-category-tag` — **REMOVED** (decision 7).
* `ingredient-category` — the override trigger, verbatim (ADR-0045 §3).
* `ingredient-category-menu` / `ingredient-category-option-<value>` — new,
  in ADR-0045's naming style.

## Consequences

- The Grocery tab's first child is still the extras group; specs that
  assume the first `[data-test=grocery-section]` is the first group must
  compare against `[data-test=extra-section]` explicitly (unchanged).
- Grouping lives in one pure lib with its own unit spec, not inline in
  the component — the repo derives and unit-tests (`grocery.ts`,
  `useGroceryList.ts`, `containers.ts`); component-local aggregation is
  the pattern this codebase avoids.
- e2e: three `selectOption()` call sites had to be rewritten (the
  dropdown is a `<button>` + popup, not a `<select>`), and the three tag
  assertions were deleted because the tag is deliberately gone. The
  never-routed assertions are unchanged and stay green.
- The `Other` bucket and `Uncategorized` are the same set of rows; only
  the *name* changes (ADR-0015 §3 inverted).

## Alternatives considered

- **Rename `Other` to `Uncategorized` in `STORE_SECTIONS` itself** —
  rejected: `Other` is the ingredient-index fallback bucket
  (`bucketFor`), used by the recipe-derived path and the add toast; only
  the extras *view* gets the friendlier name.
- **Put the extras group after the store sections** (siblings) —
  rejected: ADR-0015's "add bar and the things it creates are one visual
  unit" ordering is unchanged, and the group stays one container
  (`extra-section`) so every existing extra spec keeps its anchor.
- **A second collapse implementation for extras** — rejected (KISS/DRY):
  the brief for a bug-prone duplicate of a 20-line watcher; one done-map
  with namespaced keys is smaller and impossible to diverge.
- **Auto-collapse in ShopView's extras group** — rejected: ADR-0008's
  addendum deliberately keeps it manual-only, and e2e pins it.
- **Merge extras into the real store sections now that they are grouped** —
  rejected: that is the routing ADR-0015 rejected and this ADR explicitly
  does not resurrect.

## Decision log

- 2026-10-04 — chose a superseding ADR over editing ADR-0015: the owner
  reversed one bullet of a historical record, and rewriting history in
  place would lose the reason the reversal happened.
- 2026-10-04 — kept the extras GROUP header static (no chevron) while
  giving sub-sections toggles. The owner's ask was about categories; a
  collapsible group on top of collapsible sub-sections is two clicks to
  see nothing, and the group is one add-bar plus its children.
- 2026-10-04 — removed the per-row tag rather than keeping it "for
  accessibility": the sub-section heading carries the category, and the
  tag would be a duplicate of the line directly above it.