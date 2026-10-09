# ADR-0064: RecipeSearch component + mobile Enter dismissal

Status: accepted (2026-10-09)
Supersedes: nothing
Refines the presentation layer of ADR-0060-recipe-search-language.

## Context

The Recipes-tab search control — input, clear button, suggest dropdown,
tips disclosure and both debounce pipelines — lived inline in
`RecipesTab.vue`, which by now also owns the facets, the quick-filter
chips, the incrementally-rendered grid and the empty state. The search
control was ~200 of ~850 lines inside a component with six other
responsibilities.

That density hid a real mobile bug. `onSuggestKey` began with
`if (suggestions.length === 0) return`, and its `Enter` branch only acted
when `suggestSelected >= 0`. So:

- with the dropdown CLOSED, Enter did nothing at all;
- with the dropdown OPEN but nothing highlighted, Enter also did
  nothing — the menu stayed up;
- and no code path ever blurred the search input.

On a phone that is the worst possible outcome: the on-screen keyboard
stays up, the still-open suggest dropdown covers the top of the result
grid, and the user has to tap somewhere else to escape. The repo already
had the dismiss idiom (`SettingsTab.vue`'s identity-name input:
`@keydown.enter="($event.target as HTMLInputElement).blur()"`); the
search box just never got it.

Facts that shape the design:

- The search results pipeline (`searchResults`, `searchPending`, the
  200 ms watcher) is coupled to the query and only to the query; the
  facet/sort/grid logic consumes its output but owns none of its state.
- The suggest pipeline (150 ms debounce, `suppressNextSuggest`,
  Arrow/Escape/Enter keys, `aria-activedescendant`) is exclusively the
  search box's.
- The tips disclosure is device-local UI (ADR-0027: "a search is a
  question, not a household preference") and exists only to explain the
  search syntax.
- Every `data-test` id (`search-suggest`, `search-suggest-item`,
  `search-tips-toggle`, `search-tips-panel`, `search-clear`,
  `search-empty-tip`), the `searchbox` role and the accessible name
  "Search recipes or ingredients" are pinned by `e2e/browse.spec.ts`.
- RecipeDetail's ingredient autocomplete and the grocery autocomplete
  are DIFFERENT behaviors (different sources, different commit
  semantics); unifying them with this component is out of scope.

## Decision

1. **ONE component: `src/components/RecipeSearch.vue`.** It owns the
   search input, the clear button, the suggest dropdown, the tips
   disclosure, and all four pieces of debounce state (search timer,
   suggest timer, `suppressNextSuggest`, dropdown selection). It is the
   search CONTROL, not the results list — facets, sort, the "More
   results" divider and the grid stay in RecipesTab.
2. **The query has a single source of truth.** RecipesTab keeps the
   persisted-shape-agnostic `query` ref and passes it down with
   `v-model`; the component takes it as `defineModel<string>`. The query
   is never duplicated in two refs — both watchers live in the
   component and read the same model.
3. **The results pipeline moves into the component** (stays coupled to
   the query, decision 1) and is exposed back to RecipesTab through
   `defineExpose({ searchResults, searchPending })`; RecipesTab reads
   them off a template ref to drive its `results` computed, the
   primary/fallback split and the empty state. The 200 ms search
   watcher and the 150 ms suggest watcher both move.
4. **Enter semantics (the bug fix).** On Enter in the search input:
   - if a suggestion is highlighted (`suggestSelected >= 0`), commit it
     — existing behavior, unchanged;
   - ALWAYS, commit or not: clear `suggestions` + `suggestSelected`
     (the menu is disposed) and blur the input, so the on-screen
     keyboard closes and the results become visible. Blur is the
     keyboard-close proxy; the OS keyboard itself is not scriptable.
   - the input gains `enterkeyhint="search"`, so mobile keyboards label
     the key "Search" instead of the raw "return/newline" glyph;
   - on Enter the 200 ms search debounce is FLUSHED: the pending search
     runs now instead of a fifth of a second later. The stale-response
     guard (a response for a query the user has since changed is
     discarded) is kept verbatim.
   - `suppressNextSuggest` is untouched: a commit still suppresses the
     next suggest fetch, and a plain Enter (no commit) changes no query,
     so the invariant is preserved.
5. **`onSuggestKey` moves intact.** Arrow Up/Down, Escape and the
   aria-activedescendant wiring are unchanged; only the Enter branch is
   extended per decision 4, and Enter is now handled BEFORE the
   "dropdown empty" early-return instead of behind it.
6. **No unification with the other autocompletes.** RecipeDetail and
   grocery suggestions keep their own implementations — different
   behavior, and DRY forbids merging things that are only superficially
   similar.
7. **No persisted-state change.** The query and the tips toggle stay
   device-local, un-registered (they were never in `STORE_SLICES`).

### The trade (coding-philosophy: DRY > SOLID > KISS)

- **DRY wins on the query**: one source of truth for the query string,
  handed down the tree, with both watchers living beside the input that
  mutates it. The loser was keeping `query` in RecipesTab and mirroring
  it into the component as a prop-with-internal-copy — the cheapest
  thing to write and the classic two-refs-drift-apart bug (type in the
  box, results computed from a stale copy).
- **KISS loses a small round to DRY on the results plumbing**: the
  cleanest possible shape would have kept `searchResults` exactly where
  it is consumed (RecipesTab) and moved only the input — that is the
  KISS extraction. Instead the whole pipeline moves with the query
  (single writer principle), and RecipesTab reads it back through a
  template ref. The cost is one `defineExpose` seam; the alternative
  would have split the pipeline's ownership from its trigger across a
  component boundary, which is the harder bug class to review.
- **KISS wins where the principles tie**: the Enter-dismiss decision
  stays an inline three-liner in `onSuggestKey` rather than becoming a
  "pure dismiss helper" — extracting a function this trivial adds a hop
  without removing any duplication. No new machinery, no new deps.

## Consequences

- `RecipesTab.vue` shrinks by the search-control block and reads like a
  list page again; the search control is reviewable and testable as a
  unit.
- On mobile, Enter closes the keyboard and the dropdown in one action —
  including the open-but-unhighlighted case — and results are already
  on screen when the keyboard finishes closing (flushed debounce).
- Desktop behavior is unchanged in every visible way except that Enter
  now blurs a focused search box (a no-op interaction for mouse users,
  standard behavior for keyboard users).
- The existing suggest-commit e2e keeps passing verbatim; a new e2e
  pins the open-nothing-highlighted Enter → hidden dropdown + blurred
  input contract on both projects.
- If a future feature needs the search results somewhere else in
  RecipesTab's template, they are already exposed; if it needs them
  outside RecipesTab entirely, that is a new ADR, not a prop.
- Double-run note: a query written by the Enter-commit path can cause
  the just-flushed search to be re-scheduled once by the queued query
  watcher and run again ~200 ms later. The re-run is idempotent (same
  query, same index, results identical) and invisible; guarding against
  it would have added a dedup token for no observable gain (KISS).
