# ADR-0086: Fuzzy ingredient suggestions — typos still find the item, custom names included

Status: accepted (2026-10-13)

Numbering note: ADR-0085 is reserved in flight by `feat/replan-history`
(ADR-0085-replan-past-week.md, committed on that branch but not yet
merged — invisible to `scripts/build_adr_index.py --next`). This record
takes the following number to keep the sequence unique.

## Context

The grocery add-item autocomplete (ADR-0012 index, ADR-0014 bulk-add
loop) matches the typed query EXACTLY against the normalized nameKey,
in three tiers: typed-prefix > word-boundary > substring. A typo —
"bananna", "tommato", "chikpea" — matches nothing, and the only path
forward is committing the misspelling as a NEW custom ingredient via
the typed "+" row. That pollutes the device-local memory with a
near-duplicate and fragments the derived grocery merge: the misspelled
line never merges with the correctly-spelled lines other recipes
produce, so the household buys the same item twice under two names.

Owner asks (2026-10-13): "we need to have fuzzy search or mini search
on ingredients list when adding to groceries list — it needs to also
find the custom added one too."

MiniSearch (^7.2.0) is ALREADY a runtime dependency — it powers the
recipe catalog search (`src/lib/search.ts`, ADR-0060 family) with
`fuzzy: 0.2`, prefix matching and a custom tokenizer. The baked
ingredient index (`public/data/ingredients.json`, built by
`scripts/extract_ingredients.py`) is 871 entries; the custom-ingredient
memory (`src/stores/customIngredients.ts`, ADR-0012, device-local,
cap 500) is the second source the suggestions already merge.

## Decision

1. **Fuzzy is a tier, not a replacement — exact matches always
   outrank it.** The matcher gains tier 3, below the existing
   tiers 0–2, which keep their exact semantics and order byte-for-byte
   (every existing e2e pin on suggestion order, category chips, "mine"
   badges and the typed "+" row stays green). Fuzzy rows are computed
   only when the exact tiers leave room under `MAX_SUGGESTIONS` (8)
   and fill ONLY the remaining rows. An exact-match query therefore
   renders identically to today.
2. **MiniSearch powers the fuzzy tier.** ONE lazily-built MiniSearch
   instance indexes BOTH sources as first-class documents — the baked
   index entries AND the household's custom ingredients — searched with
   `fuzzy: 0.2` and prefix on (the same tuning the recipe search uses,
   so there is one fuzzy vocabulary in the app, not two). It is built
   client-side from already-loaded data and rebuilt when the custom
   list changes; no new dependency, no runtime fetch, offline behavior
   unchanged.
3. **Custom names are found too.** A remembered ("mine") name participates
   in the fuzzy index exactly like an index entry and keeps its "mine"
   badge and remembered category in the row. A typo'd custom name that
   used to be unreachable is now suggested.
4. **The category chip never lies.** A fuzzy row carries its source's
   store category (the index entry's, or the remembered one), so the
   pre-commit category feedback of ADR-0014 §2 holds for fuzzy rows
   too. Dedup by nameKey is unchanged.
5. **The bulk-add contract is untouched.** The typed "+" row stays row
   0 and unknown text stays addable (a misspelling the fuzzy tier cannot
   resolve is still one Enter away from being added); the
   immediate-add loop, keyboard nav, `isSuggestionListVisible` a11y
   predicate and every `data-test` hook behave exactly as before.
6. **Determinism.** Fuzzy ordering is stable (MiniSearch score, then
   alphabetical name tiebreak — same stability rule as `sortScored`),
   so e2e can pin concrete rows.

## Consequences

- A typo'd query now surfaces candidates instead of an empty dropdown;
  picking a fuzzy row adds the correctly-spelled item and the grocery
  merge keeps matching it against catalog ingredient lines.
- One MiniSearch instance (~1.4k documents) lives in module memory once
  the add-item form is used — trivial, and lazy: it is not built until
  the autocomplete is exercised.
- New unit tests pin the fuzzy tier with a fixed corpus (typo → index
  row; typo'd custom name → "mine" row; exact matches still win under
  8-row pressure); e2e gains cases in `grocery-autocomplete.spec.ts`
  / `bulk-add.spec.ts` without disturbing existing pins.

## Alternatives considered

- **Hand-rolled Levenshtein/Damerau scorer over the flat arrays** —
  works, but re-implements what MiniSearch already ships in-bundle and
  forks the fuzzy tuning away from the recipe search. Rejected (DRY).
- **Fuzzy at the TOP of the ranking (relevance order)** — a near-match
  would outrank an exact prefix match, changing every existing
  suggestion-order pin. Rejected: exact tiers keep priority.
- **A generated similarity artifact (new build-time data file)** —
  overkill for 871 names; a second artifact pipeline for what the
  runtime can index itself. Rejected.
- **A new fuzzy dependency (fuse.js et al.)** — violates the
  no-new-runtime-deps standing rule while MiniSearch already provides
  the capability. Rejected.
