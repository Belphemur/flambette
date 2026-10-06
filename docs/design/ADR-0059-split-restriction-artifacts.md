# ADR-0059 — dietary restriction artifacts are SPLIT and loaded ON DEMAND

* Supersedes ADR-0056's single-dictionary artifact layout (ADR-0056 Status stays
  **Accepted**; its "committed artifact" decision is marked
  **superseded-in-part** — the single `restriction_dict.json` is deleted, but the
  swap/drop/removal LOGIC it encoded survives in the split files).
* Companions: `scripts/build_restriction_dict.py` (renamed emission to the split
  layout), `public/data/restrictions/` (index.json, swaps.json, removed/<slug>.json,
  pairs/<a>-<b>.json), `src/lib/restrictions.ts` (ladder loader),
  `src/composables/useRestrictions.ts` (on-demand fetches)

## Context

ADR-0056 committed a single substitution dictionary, `public/data/restriction_dict.json`
(1,386,316 B). On measurement it is 96% redundant: its `pairRemoved` lists
131,920 recipe-id entries of which only **918** carry information beyond the
singles' union (measured 2026-10-07 over the fresh archive — a recipe removed by a
PAIR but by NEITHER single is the only true composition extra; the rest duplicate
what `removed/<slug>.json` already states). The information content of the whole
file is ~52 KB of real data: swaps 8 KB + removed lists 44 KB + 918 pair extras.

Shipping one 1.4 MB file for a cold start that needs NONE of it is a cold-start
tax the app should not pay, and `index.json` (12 entries) is needed by the
Settings chips whether or not any restriction is active.

## Decision

1. **The committed artifact is a SPLIT TREE under `public/data/restrictions/`**,
   keyed by what the UI needs at query time:

   | file | size | loaded when | purpose |
   | --- | ---: | --- | --- |
   | `index.json` | ~2 KB | ALWAYS (or never — see §3) | the 12 entries `{id, slug, label}` + the pair-extras file list |
   | `swaps.json` | ~8 KB | ANY restriction active | the 56 from→to entries with `quantityRule` + the drops lists (303 entries) |
   | `removed/<slug>.json` | ~4 KB × 12 | THAT chip activates | that one restriction's removed recipe ids |
   | `pairs/<a>-<b>.json` | ~1 KB × 66 | THAT PAIR activates | ONLY the composition extras (the 918 ids partitioned by pair) |

   The pair file name uses a hyphen: `pairs/gluten-free-dairy-free.json` (a < b,
   slug names, not ids). 66 files for C(12,2) = 66 unordered pairs.

2. **Swaps and drops are unified in `swaps.json`** — the from→to entries carry
   `quantityRule`, and the drops (ingredients that disappear with no swap
   counterpart) are in the same file as `drops` entries so one fetch covers "is
   my ingredient covered?" (swapName) and "is my line hidden?" (drops) together.
   `removed/<slug>.json` holds only recipe ids; `pairs/<a>-<b>.json` holds ONLY
   the extras — a pair file NEVER contains an id that either single removes
   (they are partitioned out into the single's `removed/<slug>.json`).

3. **Cold start (no restrictions): NOTHING beyond `index.json` loads.** `index.json`
   is ~2 KB and can either ship in the bundle (committed static asset, offline-first
   holds) or stay unfetched if the Settings card renders from the lib's own `RESTRICTIONS`
   constant until the user opens the card. The simpler choice is recorded below:
   `index.json` ships in the bundle and is read synchronously from the lib's
   `RESTRICTIONS` constant for the Settings chip labels; the file is ALSO committed
   so any future dynamic chip surface has a fetchable source. **Either way, zero network
   requests fire on a cold start.**

4. **The load ladder** (each step is cached, retryable, and the tests inject fakes):

   ```
   1 chip  → index.json + swaps.json + removed/<slug>.json   (~12 KB)
   2 chips → + pairs/<a>-<b>.json (only that pair's file)    (+~1 KB)
   3+ chips → singles' union (from removed/*) + any loaded
              pair extras; 3-way composition extras are NOT archived
              (upstream data does not exist for 3-sets beyond all-free).
              Fallback: union-only, with the all-free payload as the sanity ceiling.
   ```

   The runtime exposes `loadIndex`, `ensureSwaps`, `ensureRemoved(slug)`,
   `ensurePair(a, b)` — each cached, each a small fetch with an injected impl.
   `isRemovedByRestriction` consults the loaded union (from `removed/*`) + pair
   extras (from `pairs/*`); `swapName` consults `swaps.json` only when it has
   arrived (pre-load behaviour: identity — no restriction is "active-looking"
   until its data arrives; the existing aria/loading semantics are kept).

5. **Failure policy (ADR-0019's room-failure rule — never block the UI):** any
   fetch failure of a per-slug/pair file degrades to union-only (the loaded
   `removed/*` files) + toast; a failed `swaps.json` = no swaps (identity
   display) + toast. A failed `index.json` is a build failure (it ships in the
   bundle) and never degrades.

6. **Per-recipe variant data was REJECTED** (the 9.3 MB overlay experiment of
   ADR-0056 option B, plus data duplication in the app). The split tree above is
   the whole data surface: 52 KB across 81 files vs 1.4 MB in one file.

## Rationale

Why split: the single dictionary's `pairRemoved` was 131,920 entries of which
918 were informative. A user who turns on ONE chip downloads 1.4 MB to learn
what 12 KB teaches. The split tree lets the UI fetch EXACTLY what the active
set needs, and nothing for the inactive set.

Why on-demand: the Settings chips are lazy by nature — the card opens only when
the user opens Settings — so loading swaps/removed/pairs only when a chip is
active matches the user's intent and keeps the cold start at zero extra requests.

Why not per-recipe: overlays dumped per-recipe docs (ADR-0056 option B) ran to
5.1 MB / 1,649 docs; the pairing reformulation proved the substitution data
factors cleanly into from→to swaps (8 KB), removed lists (44 KB), and the 918
true extras (918 × ~1 KB). That is 52 KB, three orders of magnitude smaller.

Why the pair files are ONLY extras: every id in `pairs/<a>-<b>.json` is an id
that NEITHER `removed/<a>-<slug>.json` nor `removed/<b>-<slug>.json` removes —
the union of all pair files, merged with the singles' removed sets, reproduces
exactly what the old `pairRemoved` lists. The pair files therefore compose
cleanly with the singles and never double-count.

## Consequences

* `public/data/restriction_dict.json` and its single-file emission are DELETED.
  `scripts/build_restriction_dict.py` now emits the split tree (or the golden
  suite follows the new layout).
* The runtime's `loadRestrictionDict` is replaced by the ladder: `loadIndex`,
  `ensureSwaps`, `ensureRemoved`, `ensurePair`. Tests inject fakes for each.
* `isRemovedByRestriction` and `swapName` operate on the LADDER, not on a single
  dictionary: removed ids come from `removed/*` (union of active), pair extras
  come from `pairs/*` (only loaded for active pairs), swaps come from
  `swaps.json` (loaded when any chip is active).
* Cold start fires ZERO network requests beyond the bundle (index.json ships in
  the bundle; swaps/removed/pairs fire only on activation).
* Backups still carry the restriction ids (the `dietaryRestrictionIds` slice,
  ADR-0013); the artifacts they point at are the split tree, not the old dict.
* The 918 partition is exact and testable: `sum(pair_files.extras) == 918` and
  each pair file contains ONLY union-extras (no id any single removes).
