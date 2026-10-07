# ADR-0060: Recipe search query language and pre-built index

**Status:** Accepted (2026-10-06)
**Extends:** ADR-0001 (offline frozen catalog), ADR-0012 (ingredient index
autocomplete), ADR-0052 (user recipes are catalog entries).
**Implements:** [#50 — Refine recipe search function](https://github.com/Belphemur/flambette/issues/50)

## Context

Recipe search today (`src/lib/search.ts`) is a MiniSearch index over
`name` (boost 2) + joined ingredient names with `prefix: true` and
`fuzzy: 0.2` — and no `combineWith`, so MiniSearch's default OR applies.
Typing a full recipe title floods the grid with thousands of loosely
matching recipes instead of surfacing the one the user named (issue #50).
The reporter also asks for the standard search operators: `"phrases"`,
`AND`/`OR`, `+include` / `-exclude`, `(...)` grouping, and `*` wildcards.

Separately, the index is rebuilt client-side on first access: every load
tokenizes 2,759 recipe names plus their ingredient lists in the browser.
Small, but it is work repeated on every cold start that the build could do
once.

Alternatives evaluated (researched 2026-10-06):

- **Fuse.js** — a fuzzy matcher, not a full-text engine: no query
  language, no stemming, no suggestions. Worse fit for exactly this issue.
- **FlexSearch** — fastest raw engine, but no query language and a
  verbose API; migration cost buys nothing we need.
- **Lunr.js** — the only rival with a full query language, but it is in
  maintenance mode (last release years ago), ~28 kB vs MiniSearch's
  ~7 kB, tf-idf only, no auto-suggest. Inheriting a frozen parser is a
  bad trade.
- **Meilisearch / Typesense** — server engines; violate ADR-0001 (no
  runtime requests to any host, e2e-enforced). Out.
- **IndexedDB persistence** — considered for the index. Rejected: the
  catalog is frozen and ships with every release, so a client cache needs
  an invalidation subsystem for data nginx/Cloudflare already cache
  correctly; first load gets *slower* (parse + structured-clone write);
  the data is in memory all session anyway. The HTTP-cached static asset
  gives the same benefit with none of the failure surface.

MiniSearch v7 itself already provides everything except the query
language: `combineWith: 'AND'`, per-term `prefix`/`fuzzy` **callbacks**
(so a `foo*` term can be prefix-only while bare terms stay exact),
`boostTerm`, `filter`, and `autoSuggest()`. The parser is a thin pure
layer on top — ~100 lines of tokenizer + set algebra over per-clause
MiniSearch results. Zero new dependencies.

## Decision

1. **Default bare query → AND, with OR-fallback results appended below.**
   The primary result list contains only documents matching every term
   (fixes "type the title, get the recipe"); if the AND result set is
   smaller than the display window, forgiving OR matches follow under a
   visible separator. Explicit operators always win over the defaults.
   This is the compromise between strictness and browse-forgiveness;
   AND-strict was rejected because it would harden every casual query.

2. **A query language parsed by a pure function in `src/lib/search.ts`:**
   `"exact phrases"` (token-adjacency checked against the in-memory
   `name`/ingredient strings — MiniSearch has no positions), case-sensitive
   `AND` / `OR` (uppercase, like real engines; lowercase words stay search
   terms), `+must` / `-must-not`, nested `(...)` groups with the same
   operators, and a trailing `*` per term. Grammar: `OR` splits top-level
   `AND` groups; each term carries its own match mode via MiniSearch's
   per-term option callbacks. Unbalanced quotes/parens degrade to literal
   terms rather than throwing.

3. **`autoSuggest()` wired to a small suggestion dropdown** under the
   Recipes-tab search box (keyboard-navigable, `aria-*` complete,
   `data-test="search-suggest"`). Biggest usability win, free from the
   existing dependency.

4. **The search index is pre-built at build time** and shipped as a
   committed static asset, same pipeline discipline as
   `pack_index.json` (ADR-0024):
   - `scripts/build_search_index.ts` (run by Bun) reads
     `public/data/builder_data.json`, builds the MiniSearch index with the
     EXACT options `src/lib/search.ts` uses, and writes
     `public/data/search_index.json` (MiniSearch `toJSON` format). The
     builder imports the doc-shaping and options from `src/lib/search.ts`
     so the two sides cannot drift — the same lockstep pattern as
     `verify_pack_index_parity.ts`.
   - The runtime replaces `addAll` with `MiniSearch.loadJSON` (same
     options object); zero client-side indexing.
   - **User recipes ARE included in the prebuilt index.** The generator
     reads `public/data/user_recipes.json`, merges it into
     `catalog.variantMeta` via the REAL catalog pipeline (`buildCatalog` +
     `parseUserRecipes` from `src/lib/catalog`, the same code the app uses
     at runtime — never copied), then indexes `catalog.variantMeta`.
     This guarantees the index and the app see identical user-recipe data
     (lockstep, not a hand-maintained copy). **Every change to
     `user_recipes.json` requires re-running `bun run data:search`** —
     the prebuilt index is stale otherwise.
   - Gates: `bun run data:search` regenerates; the script's `--check`
     mode rebuilds in memory and fails on drift from the committed file,
     wired into `bun run test:data` like every other generated artifact;
     `package.json` gains a `data:search` script.

5. **Scope guards:** all of it lives in `src/lib/search.ts` (+ the
   generator) as a pure lib — quick filters keep running OUTSIDE search
   (ADR-0027); no persisted store slices change (no STORE_SLICES entry);
   no new runtime dependencies; no request to any non-app host
   (ADR-0001). Search results still return raw variant ids with no facet
   knowledge.

## Consequences

- Typing a recipe title now surfaces that recipe at the top instead of
  an OR flood; power users get the full operator set from issue #50.
- First load drops the client-side tokenize/index pass (one `fetch` +
  `loadJSON` instead); the index file is HTTP-cached like every other
  generated artifact and refreshed by `data:search` whenever the catalog
  changes (`sync_catalog.py` consumers re-run the generators; the
  add-recipe procedure's generator list gains `data:search`).
- A stale `search_index.json` fails `bun run test:data` loudly instead of
  silently degrading relevance.
- Fuzzy (0.2) and prefix remain available per-term: bare terms keep
  prefix+fuzzy for forgiveness; `*`-suffixed terms are prefix-only;
  quoted phrases and `+`/`-` terms are exact. Ranking keeps the existing
  name-boost.
- e2e gains cases for: title query returning one result, `-exclusion`,
  phrase, suggest dropdown, and the OR-fallback separator. Existing
  catalog-search specs may pin new result orders — those pins are
  UPDATED, not weakened.

## Alternatives considered

- **AND-strict default** — rejected: too harsh for casual browsing; the
  OR-fallback under a separator keeps the forgiving behaviour while the
  primary list stays precise.
- **Lunr.js migration** — rejected above: frozen dependency for a parser
  we can write in ~100 lines over MiniSearch's own primitives.
- **IndexedDB-cached index** — rejected above (ADR-0001-adjacent failure
  surface for a benefit HTTP caching already provides).
- **Server-side search** — violates the offline-first rule.