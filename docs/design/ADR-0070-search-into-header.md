# ADR-0070: Search moves into the header

**Status:** Accepted (2026-10-09)
**Reconciles with:** ADR-0065 (full-bleed header band, 1100px content
alignment), ADR-0027/0028 (QuickFilters object — search stays out)
**Companions:** `docs/EXPERIENCE.md` §5

## Context

The Recipes & Catalog desktop render places the search well in the header
band, right of the wordmark — not stacked above the filter row. The owner
explicitly asked for this migration. ADR-0027's rule that search is "a
question, not a household preference" must survive the move: the field
changes HOME, not STATE.

## Decision

1. On **desktop (≥768px), while the Recipes tab is active**, the search
   field renders in the header band as an ADR-0065 **sunken well**
   (`surface-sunken` fill, `border-strong` keyline, tomato focus),
   width-capped and aligned to the 1100px container like every header
   element. On other tabs the header composes without the well.
2. **One component, two mount points:** a single `RecipeSearchField`
   renders in the header at `lg:` and at the top of the Recipes content
   below it — never two implementations. The mobile Recipes render keeps
   search in-content, which is why the split follows the breakpoint.
3. **The query is ephemeral state, not a preference:** it lives in a
   module-scope composable (`useRecipeSearch`, a shared singleton ref)
   read by header and view alike. NOT persisted (a search is a question)
   and NEVER room-synced (per-device intent, not household state).
4. Desktop affordance: `/` focuses the search (ignored while typing in
   another field), with a `kbd` hint. The field keeps `role="search"`,
   its `aria-label`, and its `data-test` hooks — specs relocate
   selectors, nothing else changes (`waitForCatalog`, filter chips and
   grid pins are unaffected).
5. Switching tabs keeps the query in memory; returning to Recipes
   restores it. Launching the app starts with an empty query.

## Consequences

- `RecipesTab` loses its local search ref (MiniSearch wiring stays in the
  lib layer, unchanged).
- e2e specs touching the search input re-pin to the new mount point;
  selector names are unchanged.
- No store migration, no backup-registry change, no room-payload change.
- ADR-0016's Pixel 7 tab fit is untouched (mobile header stays as-is).

## Addendum (2026-10-09): tips discoverability

Owner ruling: the tips disclosure survives the header move but is too
easy to miss, and the one-shot auto-expand stays FORBIDDEN (the search
campaign's standing ruling — no reversal). The disclosure comes back
as a CONTEXTUAL reveal:

- The zero-result empty state's hint gains a **"Show search tips"**
  button that opens the disclosure (`search-tips-panel`) — the hint no
  longer dead-ends as static text.
- The toggle becomes a **`?` affordance beside the desktop header
  search well** (aria-labelled, `aria-expanded`), replacing the
  right-aligned text link below the grid header; mobile keeps the
  disclosure toggle with the panel mount.
- The disclosure itself stays closed-by-default, device-local,
  content-level (not part of the field component) — ADR-0027's
  ephemeral/search-is-not-a-preference rule is untouched.

## Addendum 2 (2026-10-09): the well is persistent — all tabs

Owner ruling: **the search bar is visible on ALL screens.** This
AMENDS Decision 1's "while the Recipes tab is active" scoping:

- The header well renders on every tab at `lg:` (same mount, same
  component, same ephemeral composable — the query does not care where
  you type it).
- Searching from a non-Recipes tab ROUTES to Recipes: the grid is the
  only results surface, so the first keystroke (or submit) while
  elsewhere switches the route and the results render under the same
  query. Leaving Recipes keeps the query in memory (Decision 5).
- Mobile is unchanged: no header field at small widths; the field stays
  on the Recipes content mount (the Pixel 7 header has no room for a
  well — ADR-0016).
- The `?` tips affordance (Addendum 1) rides the well on every tab.
