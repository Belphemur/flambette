# ADR-0018: Diet rules are a keyword classifier over ingredient names

**Status:** Accepted (2026-09-28)
**Extends:** ADR-0012 (ingredient-name normalization is already the
merge key) and nothing else — no other subsystem is touched.

## Context

The frozen snapshot has **no diet or allergen metadata**. Verified
across all 2,730 recipe documents: there is no `diet`, `allergen`,
`vegetarian` or `vegan` field anywhere in the docs, and the only
self-identifying signal is free text — 19 recipes say "vegetarian" or
"vegan" in their name and 6 more mention it in `cooking_tip`. The
builders modelled protein, not diet.

Users still ask the question ("what can I eat tonight that is
vegetarian?"), and the one structured signal that *is* there is the
ingredient list: chicken appears in 466 recipes, pork 195, salmon 138,
beef 120, shrimp 118, tofu 69, tempeh 9. A keyword classifier over
those names is cheap, fully offline, and good enough to be a useful
lens.

## Decision

1. **`src/lib/dietFilter.ts` is the single classifier.** Five rules —
   `no-pork`, `no-shellfish`, `no-meat` (pescatarian: fish is fine),
   `vegetarian`, `vegan`. A recipe matches a rule when **no** line item
   violates it. Multi-select is an intersection (AND).

2. **Curated keyword tables per rule, in-repo.** Ingredients are
   lowercased, split on non-letters, singularized (`bunches` → `bunch`)
   and matched as *contiguous token sequences*, never as raw
   substrings. That word-boundary rule is what keeps `egg` from firing
   on `eggplant` and `ham` from firing on `chamfer`. The tables live in
   the module (pork/bacon/pancetta/prosciutto/ham/chorizo/lard,
   shrimp/prawn/lobster/crab/clam/mussel/oyster/scallop/crawfish,
   beef/chicken/turkey/duck/lamb/veal/sausage/brisket/steakette/broth/
   stock/bouillon/gravy, salmon/tuna/cod/dashi/worcestershire, dairy,
   egg, honey) and are the thing to extend when the catalog grows.

3. **Anomaly handling.** A curated set of "hidden" animal products
   flags the vegetarian/vegan rules even when the name sounds savoury:
   `gelatin`, `rennet`, `carmine`, `lard`, `ghee`, `dashi`,
   `fish sauce`, `shrimp paste`, `oyster sauce`, `worcestershire`.
   Conversely, **exemptions** suppress a hit for an ingredient that
   merely contains the word: plant milks/creams (`oat milk`, `coconut
   cream`), `butter beans`, `apple butter`, `vegetable stock/broth`,
   and the catalog's literal `chicken or vegetable broth` line item.

4. **Classification runs once, over `VariantMeta.ingredient_names`.**
   The catalog is already loaded in memory and its ingredient names are
   the same set as each document's `line_items` (verified modulo
   singular/plural spelling), so there is no reason to fetch 2,730
   documents. Whole-catalog classification takes ~120 ms and is memoized
   (`dietIndexFor`) — the snapshot is frozen, so verdicts and chip
   counts are computed exactly once per app lifetime.

5. **UI: chips on the Recipes tab, multi-select, persisted.** Each chip
   carries its match count (`Vegan (152)`) and is `aria-pressed`. The
   active set lives in the `ui` store as `dietFilters` and rides the
   `settings.json` backup slice (ADR-0013's single-registry rule) with
   validation on import: unknown rule ids are dropped, not trusted.

## Consequences

- **This is a suggestion lens, not a guarantee.** The classifier has
  both false positives (`creamed corn` reads as dairy; a dish listing
  "chicken stock" is not vegan) and false negatives (a dish whose
  maker wrote "vegetable stock" meaning the real thing). The e2e suite
  asserts *membership in the precomputed id set* rather than exact
  counts for exactly this reason — the set is the contract, not a
  hand-written list of "correct" recipes.
- The chip count is honest about being derived: it is the number of
  recipes the rules accept, so shrinking the keyword tables visibly
  shrinks the counts.
- Diet filters currently apply to the Recipes browse path. There is no
  suggestion engine in the app to filter, so nothing else consumes
  `dietFilters` yet — the store field is the seam for one.
- Extending the rules is a one-line table edit plus a unit test; no
  schema, no metadata, no server.
