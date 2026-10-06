# ADR-0056 — dietary restrictions: a committed substitution dictionary, runtime-applied

* Extends: ADR-0018 (diet chips — superseded for restriction-type filtering), ADR-0057 (profile-archive machinery), ADR-0013 (backup registry), ADR-0003 (derived grocery), ADR-0024 (Auto-Plan eligibility outside the pure lib), ADR-0022 (measured amounts under step text)
* Status: **Accepted, superseded-in-part** — artifact layout superseded by ADR-0059 (split tree); swap/drop/removal logic survives
* Companions: `scripts/build_restriction_dict.py`, `scripts/build_restriction_sets.py` (verification-only), `src/lib/restrictions.ts`, `src/composables/useRestrictions.ts`; DATA: `public/data/restrictions/` (index.json, swaps.json, removed/<slug>.json, pairs/<a>-<b>.json); `public/data/restriction_dict.json` DELETED

## Context

ADR-0018 gave the Recipes tab diet chips built from a keyword classifier,
because the frozen catalog carries no diet metadata. That lens is a
*guess*. Upstream Mealime has the real thing: `set_profile` accepts
account-level `recipe_restriction_ids`, and the render that follows is the
authoritative answer to "what can a gluten-free household cook?"

The restriction archive (ADR-0057's machinery, extended by
`--restrictions`) captured all twelve single-restriction renders live on
2026-10-06 (`../mealime-media/raw_profiles/restrictions/`, US units /
6 servings — the account's setting at archive time), plus `none` and
`all-free` baselines. Reading those payloads settles the mechanism:

| measured fact | value |
| --- | --- |
| restricted render is a **strict subset** | `added=0` held for all 12 (validated at build time) |
| single-restriction survivors | GF 2,264 · DF 1,384 · Fish 2,459 · Shellfish 2,652 · Peanut 2,634 · Tree Nut 2,379 · Soy 2,336 · Nightshade 779 · Egg 2,086 · Sesame 2,435 · Mustard 2,244 · Sulfite 1,681 (vs 2,759 baseline) |
| restriction id map | 1 Gluten · 2 Dairy · 3 Fish · 4 Shellfish · 5 Peanut · 6 Tree Nut · 9 Soy · 10 Nightshade · 11 Egg · 12 Sesame · 13 Mustard · 14 Sulfite (7, 8 exist upstream, are unused, and `set_profile` **404s** on them) |
| shared recipes | line-item structure mostly survives, and the rework is upstream's own: names swap per recipe (`rotini pasta` → `gluten-free rotini pasta`; `soy sauce` → `tamari soy sauce` in one doc, `coconut aminos` in another), step prose changes only where it names the swap |
| line-item COUNTS are NOT invariant under a rework | 444 of 1,649 changed docs moved the count: a protein substituted away vanishes (GF rid 863: shrimp → *eggs*, fish sauce + soy sauce → one `tamari soy sauce`, 16 → 15 lines) and one line can split into two (GF rid 1292: flour tortilla → avocados + butter lettuce, 15 → 16) |
| line ORDER is stable | 99.91% positional name agreement between the US and metric renders of the same recipe (34,832 lines); zero pure reorders *(CORRECTED 2026-10-07 — the metric archive found pure reorders: GF rids 224, 235 and 2195 swap their pasta/garlic/tomato lines. See the change note.)* |
| changed-doc detection needs no fetch | the payload's `ingredient_names` differ from the unrestricted baseline iff the doc was reworked |

Also measured the hard way: `set_profile` applies ASYNC — a fetch 2 s
after the POST once returned renders for the WRONG setting (a Paleo render
and a shellfish render where soy/nightshade were asked). The archiver
settles 6 s and the builder still validates the subset invariant, so a
raced payload fails the build loudly instead of shipping a wrong
`removed` set.

## Decision

1. **The committed data is a SPLIT TREE under `public/data/restrictions/`** (superseded-in-part by ADR-0059 — the single `public/data/restriction_dict.json`, 1,386,316 B, is DELETED; its 131,920 `pairRemoved` entries carry only 918 informative extras beyond the singles' union; the split tree ships those 918 exactly, partitioned by pair, plus swaps 8 KB + removed lists 44 KB). 
   `index.json` (~2 KB — the 12 entries `{id, slug, label}` + the pair-extras file list; loaded when the Settings card opens, or read from the lib's own `RESTRICTIONS` constant at cold start), `swaps.json` (~8 KB — the from→to entries with `quantityRule` + the drops lists; loaded when ANY restriction is active), `removed/<slug>.json` (~4 KB × 12 — one restriction's removed recipe ids; loaded when THAT chip activates), `pairs/<a>-<b>.json` (~1 KB ×66 — ONLY the composition extras; loaded when that PAIR is active).

2. **Swaps are derived from upstream's own restricted docs, never
   invented.** `scripts/build_restriction_dict.py` reads the archived
   single-restriction payloads (`<slug>-m6.json`), extracts swap events
   (from_key → to_key) between the unrestricted baseline and each
   restriction, tallies the `quantityRule` upstream applied (verbatim,
   rescale, re-authored — measured 99.8% / 0.1% / 0.1%), and emits the SPLIT TREE (`public/data/restrictions/`). The split files are the ONE source of truth for the runtime; `scripts/build_restriction_sets.py` is verification-only and checks the artifacts' well-formedness and symmetry.

3. **Removal is computed at query time, not pre-computed.**
   `isRemovedByRestriction(recipeId, activeIds, index)` iterates the
   active ids and checks each restriction's `removed` list and its
   `pairRemoved` entries (a pair's extras apply only when BOTH restrictions
   are active). Because the dictionary stores `removed` and `pairRemoved`
   rather than a pre-computed union, a recipe removed by an INACTIVE
   restriction must not disappear — the filter keys on ACTIVE ids only.

4. **The key/display split is load-bearing.** Display functions
   (`restrictedDocView`, `groceryDisplayLines`) take the indexed
   dictionary and apply swaps to `line_items` ingredient names by
   `nameKey` match. The base doc's quantity string stays verbatim; ids
   stay base. Every persisted or derived key stays keyed by the BASE
   doc's name. A restriction toggle can never orphan or uncheck a saved
   item.

5. **Prose stays authentic (ADR-0022).** Substitution applies ONLY to
   ingredient names inside `line_items`. Step instructions, recipe
   prose, and all other text pass through unchanged. A swap
   (`rotini pasta` → `gluten-free rotini pasta`) changes the ingredient
   name on the line; it never rewrites the sentence that mentions it.

6. **User recipes are out of the mechanism by construction.** A household
   recipe has no upstream re-authoring to display instead of its authentic
   text, so it stays visible under EVERY restriction. Authors who WANT a
   restricted variant add it as a SEPARATE household recipe (upstream's own
   model). When naming its substituted ingredients, prefer names already
   covered by the dictionary's `swaps[].from` so the runtime can
   auto-substitute. If a NEW substitution is needed, add it to the
   dictionary via `scripts/build_restriction_dict.py`'s input, rebuild,
   and run `bun run test:data` (which gates on the dictionary
   well-formedness and symmetry). `.agents/skills/mealime-add-recipe/`
   documents this workflow in full.

7. **Backup & restore is part of the feature.**
   `ui.dietaryRestrictionIds` (device-local) is registered in `STORE_SLICES`
   the same change (the standing ADR-0013 rule). Export carries the ids;
   import restores them; a backup WITHOUT the key means "don't touch"
   (the standing absent-≠-wipe rule); an id the dictionary does not cover
   is dropped by the store's normalizing writer rather than failing the
   whole archive.

8. **Household room sync is deliberately deferred.** The ids do NOT ride
   the room payload. Restriction is a household-wide concern in spirit,
   but reconciling it needs ADR-0031's per-record rules (or whole-state
   LWW semantics) decided on their own; until then each device filters
   itself.

## Consequences

* The feature is fully offline: the dictionary ships in the bundle, the
  archive lives outside the repo, and no app code ever requests a
  mealime.com host (the e2e block enforces this).
* The dictionary is small (~265 KB) and loaded once at app startup via
  `loadRestrictionDict` (lazy, retryable, injectable for tests). `useRestrictions()`
  exposes `index` (built once), `activeIds`, `ensureLoaded`, `isRemoved`, and
  `dict` — every view takes `index.value` as a parameter, keeping the lib pure.
* `--check` (wired into `test:data` via `test_build_restriction_sets.py`
  and `build_restriction_dict.py`) is offline at two tiers: committed-vs-catalog
  goldens always; a byte-identical cache-only rebuild when the local archive
  is complete. A CI runner without the archive skips the archive-faithfulness
  tier rather than failing.
* The stale golden the brief asked for ("every overlay doc's line_items
  count equals the base doc's count") is FALSE on the real archive — the
  gates that replace it are join correctness (`doc.recipe_id`), the
  payload-census drift warning, and the build-time assertion that a
  restricted render never ADDS recipes.
* The archived US/6 renders and the committed metric catalog can drift as
  upstream publishes: rerunning the archiver + builder refreshes both,
  and the `all-free`/`none` baselines re-pull with them.

## Change note (2026-10-07, PR #54 fixes)

Two owner-reported bugs corrected the record above without changing the
architecture:

1. **The substitutions are now UNIT-FAMILY INVARIANT.** The first archive
  pulled US/6 payloads, and the runtime swapped whole `line_items` in —
  so a metric/dual device displayed a restricted recipe stuck in imperial
  (`24 fl oz chicken or vegetable broth`). The archiver re-pulled every
  restriction profile with `unit_family_id: 1` (Metric), `serving_count: 6`
  (`<slug>-m6.json`; the `-us6` payloads stay on disk), and the build
  consumes them. The `removed` sets are IDENTICAL between the two unit
  families (measured 12/12) — units don't change feasibility — and a
  golden pins that. No imperial measurement token survives in any
  substitution quantity; the parenthesised container annotation is exempt
  (upstream authors physical package sizes there even in metric renders —
  the base metric doc says `1 ½ (3 oz) pkgs` alfalfa sprouts verbatim).

2. **Positional-only grocery pairing is gone (Decision 4 refined).** The
  "zero pure reorders" measurement above was wrong: reworks can REORDER
  lines, and pairing the swap NAME positionally onto base lines once
  displayed `6 cloves gluten-free fettuccine pasta` — a (name, quantity)
  pair that appears in NEITHER doc. `groceryDisplayLines` replaces
  `groceryDisplayNames`: the SAFE case (counts equal AND per-index
  quantities equal) keeps the positional name override; the MISMATCH
  class displays the substitution's OWN line list (name + quantity from
  one doc — the invariant), keys staying BASE-derived: nameKey match
  first, positional among the leftovers, self-keyed for a split's extra
  line, base-verbatim for a collapse. When upstream re-authored the
  AMOUNT of a matched pair (measured: 211 matched-pair quantity diffs),
  the row carries the base `keyQuantity` so the checkbox key's amount
  spelling stays the base doc's and a check survives the toggle.

## Alternatives considered

* **Runtime fetching of restricted renders (option B, deleted).**
  Rejected for option C: the overlay dump was 5.1 MB / 1,649 docs, the
  payloads are lazy-loaded (a single slug is up to 2.8 MB), and the
  per-recipe render is upstream's wholesale rework of `line_items` and
  `instructions` — too heavy for a dictionary-era runtime that keys by
  nameKey and applies swaps at query time. The substitution data was
  distilled into the 265 KB dictionary instead.
* **Runtime fetching of restricted renders.** Rejected outright — the app
  is offline-first and `expectZeroMealimeRequests` is load-bearing.
* **Metric re-authoring of substitution quantities at build time.**
  Rejected: not our authoring to do, and the golden pins the verbatim
  unit-family rendering.
* **Restriction as a plan-state filter** (hide planned restricted
  recipes). Rejected: it would orphan plan entries and grocery state the
  moment a chip toggles; discovery-only keeps every key alive.

## Compositions (measured 2026-10-07)

The 66 two-restriction combinations have been archived
(`archive_catalog_profiles.py --combinations`, `../mealime-media/raw_profiles/restrictions/combos/`, gitignored analysis input) and analysed
(`scripts/analyze_restriction_combinations.py`, results in `docs/analysis/`).
Joins are on the stable `recipe_id`; line-level events come from the
restricted docs in the build cache. Findings are measured, not assumed —
they are the INPUT to the composed-subset design decision; the DECISION
is the owner's.

## Three mechanisms, faithfully reproduced (measured 2026-10-08 over the fresh archive)

Upstream's restriction filtering is NOT just an exclusion filter. Three
mechanisms are in effect, all reproduced by the dictionary
(`public/data/restriction_dict.json`) at build time and enforced by the
runtime (`src/lib/restrictions.ts`).

### 1. Exclusion — restricted catalogs are strict subsets

The restricted render removes recipes outright. `added=0` holds for all 12
restrictions (validated at build time). Measured against the 2,759-catalog
baseline, the single-restriction survivors are:

| restriction | kept | removed |
| --- | ---: | ---: |
| Gluten-Free | 2,264 | 495 |
| Dairy-Free | 1,384 | 1,375 |
| Fish-Free | 2,459 | 300 |
| Shellfish-Free | 2,652 | 107 |
| Peanut-Free | 2,634 | 125 |
| Tree Nut-Free | 2,379 | 380 |
| Soy-Free | 2,336 | 423 |
| Nightshade-Free | 779 | 1,980 |
| Egg-Free | 2,086 | 673 |
| Sesame-Free | 2,435 | 324 |
| Mustard-Free | 2,244 | 515 |
| Sulfite-Free | 1,681 | 1,078 |

The dictionary's `removed` sets reproduce these EXACTLY (495/1375/125/107 /
etc., verified). Removal is computed at query time — `isRemovedByRestriction`
iterates the ACTIVE ids only, so a recipe removed by an INACTIVE restriction
must not disappear from discovery.

### 2. Substitution — kept recipes get ingredient swaps

Kept recipes get ingredient name swaps. The dictionary carries 88 swap
entries total (measured, not invented) — per restriction, each entry is
`{ from, to, quantityRule, count }` where `from`/`to` are the catalog-
spelling ingredient names and `quantityRule` is one of `verbatim` (99.8%),
`rescale` (0.1%), `re-authored` (0.1%) — the three measured categories from
upstream's rework. The runtime applies swaps by `nameKey` match; base
documents stay the key basis (the key/display split).

| restriction | swap entries |
| --- | ---: |
| Gluten-Free | 23 |
| Dairy-Free | 13 |
| Fish-Free | 15 |
| Shellfish-Free | 4 |
| Peanut-Free | 5 |
| Tree Nut-Free | 5 |
| Soy-Free | 5 |
| Nightshade-Free | 4 |
| Egg-Free | 9 |
| Mustard-Free | 0 |
| Sesame-Free | 0 |
| Sulfite-Free | 5 |

### 3. Drop — kept recipes lose ingredients with no substitute

Kept recipes sometimes lose an ingredient outright — no swap counterpart
exists in that recipe (e.g. `crumbled feta cheese` under DF, `plain Greek
yogurt` under DF). The dictionary carries a `drops` list per restriction:
`{ from, count }` entries counting how many KEPT recipes under that
restriction lose the ingredient with no substitute. A from-ingredient that
swaps in SOME recipes and drops in others gets BOTH representations — count
each kind (e.g. `butter, unsalted` under DF: 19 swaps to virgin coconut
oil AND 63 drops). Total: 303 drop entries across 12 restrictions.

The runtime HIDEs display lines whose `nameKey` is in the active
restriction's drops set (union across active ids) ONLY when no swap applies
for that line; keys and checked state are UNTOUCHED (the line is hidden for
display only; un-hiding on toggle restores the row automatically — the key
never changed).

### Dictionary schema (committed: `public/data/restriction_dict.json`)

Per restriction id:

- `removed` — `number[]` of recipe_ids upstream drops (query-time filter
  basis)
- `pairRemoved` — `Record<string, number[]>` — per two-restriction pair,
  recipe_ids removed by the PAIR but by NEITHER single (composition extras;
  apply only when BOTH restrictions are active)
- `swaps` — `{ from, to, quantityRule, count }[]` — ingredient name swaps
  with the measured quantity rule and event count; `from`/`to` use the
  BASE CATALOG doc's exact spelling (catalog `nameKey` preserves
  punctuation; the Python `name_key` FOLDS it — the folded spelling must
  NEVER be used as a `from` key or the runtime match breaks — Bug A)
- `drops` — `{ from, count }[]` — ingredients that DISAPPEAR in kept
  recipes with no swap counterpart; counted per restriction; `from` uses
  catalog spelling; a from-ingredient may appear in BOTH `swaps` and `drops`
  (Bug B)

The build pipeline: `scripts/build_restriction_sets.py` (pairing + event
extraction) → `scripts/build_restriction_dict.py` (dictionary assembly) →
`public/data/restriction_dict.json` (committed, ~1.4 MB). The pairing
fallback in `pair_lines` matches on name containment + quantity agreement
Bug C fix; the runtime's `pairOverlayToBase` mirrors this.

**Gate**: `scripts/test_build_restriction_sets.py` verifies the committed
dictionary is well-formed and that `removed` sets exactly match the payload
subset difference (tier 1 — offline always; tier 2 — archive-faithfulness,
skips without the archive). `build_restriction_dict.py --check` verifies the
on-disk artifact. The e2e suite pins the v2 default 4-pack and the GF
substitution (`rotini pasta` → `gluten-free rotini pasta`), the DF drop
(`crumbled feta cheese` hidden), and the DF swap (`butter, unsalted` →
`virgin coconut oil`).
