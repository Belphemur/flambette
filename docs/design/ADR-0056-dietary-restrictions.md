# ADR-0056 — dietary restrictions: upstream's own reworks, committed offline; filter is discovery-only

* Extends: ADR-0018 (diet chips — superseded for restriction-type filtering), ADR-0055 (profile-archive machinery), ADR-0013 (backup registry), ADR-0003 (derived grocery), ADR-0024 (Auto-Plan eligibility outside the pure lib)
* Status: **Accepted**
* Companions: `scripts/archive_catalog_profiles.py --restrictions`, `scripts/build_restriction_sets.py`, `public/data/restriction_sets.json`, `public/data/restriction_overlays/`, `src/lib/restrictions.ts`, `src/composables/useRestrictions.ts`

## Context

ADR-0018 gave the Recipes tab diet chips built from a keyword classifier,
because the frozen catalog carries no diet metadata. That lens is a
*guess*. Upstream Mealime has the real thing: `set_profile` accepts
account-level `recipe_restriction_ids`, and the render that follows is the
authoritative answer to "what can a gluten-free household cook?"

The restriction archive (ADR-0055's machinery, extended by
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
| line ORDER is stable | 99.91% positional name agreement between the US and metric renders of the same recipe (34,832 lines); zero pure reorders |
| changed-doc detection needs no fetch | the payload's `ingredient_names` differ from the unrestricted baseline iff the doc was reworked |

Also measured the hard way: `set_profile` applies ASYNC — a fetch 2 s
after the POST once returned renders for the WRONG setting (a Paleo render
and a shellfish render where soy/nightshade were asked). The archiver
settles 6 s and the builder still validates the subset invariant, so a
raced payload fails the build loudly instead of shipping a wrong
`removed` set.

## Decision

1. **The committed artifacts carry upstream's own reworks, never a
   re-authoring of ours.** `public/data/restriction_sets.json` is the
   control plane (per restriction: slug, label, sorted `removed`
   recipe_ids, overlay path, `swapped_docs` count).
   `public/data/restriction_overlays/<slug>.json` carries, for every CHANGED
   doc, upstream's restricted rendering of `line_items` and `instructions`
   wholesale — quantities verbatim, step prose verbatim. The runtime never
   interprets a swap table; it displays the reworked doc. Total committed:
   **5.1 MB / 1,649 reworked docs** (GF 860 · DF 268 · Fish 171 · Egg 117 ·
   Tree Nut 62 · Soy 47 · Shellfish 42 · Nightshade 22 · Peanut 19 ·
   Sulfite 38 · Mustard 3 · Sesame 0).

2. **Everything keys by the stable `recipe_id`** (ADR-0055: variant ids and
   `published_recipe_uuid` are re-issued per render). Only docs present in
   the committed catalog get overlays.

3. **The key/display split is load-bearing.** The overlay is DISPLAY truth
   only. Every persisted or derived key — grocery line keys
   (`nameKey || amount basis`), checked state, cleared-ingredient keys,
   extras reconciliation — stays keyed by the BASE doc's name. `restrictedDocView`
   (recipe detail, cooking view, measured chips) replaces
   `line_items`/`instructions` wholesale; `groceryDisplayNames` overrides
   only the grocery group's display NAME, positionally, and only when the
   rework kept the line count. A restriction toggle can never orphan or
   uncheck a saved item.

4. **The filter is discovery-only.** An active restriction removes recipes
   from the Recipes tab (search included — the removal sits in the shared
   facet pipeline) and from Auto-Plan's eligible pool (resolved OUTSIDE
   the pure planner, into the `excludeIds` — ADR-0024's rule). A recipe
   already planned/checked when the restriction was enabled STAYS on Plan
   and Grocery: the filter applies to choosing what to cook next, not to
   rewriting existing plan state.

5. **Multi-restriction semantics: smallest id wins.** Upstream composes
   restrictions inside one render; we archive the twelve singles. When two
   active restrictions both rework one doc, the runtime applies the
   smaller id's overlay (deterministic, documented — not an attempt to
   synthesize the composition). Removal is the UNION over active ids.

6. **Backup & restore is part of the feature.**
   `ui.dietaryRestrictionIds` (device-local) is registered in `STORE_SLICES`
   the same change (the standing ADR-0013 rule). Export carries the ids;
   import restores them; a backup WITHOUT the key means "don't touch"
   (the standing absent-≠-wipe rule); an id the artifacts do not cover is
   dropped by the store's normalizing writer rather than failing the whole
   archive.

7. **Household room sync is deliberately deferred.** The ids do NOT ride
   the room payload. Restriction is a household-wide concern in spirit,
   but reconciling it needs ADR-0031's per-record rules (or whole-state
   LWW semantics) decided on their own; until then each device filters
   itself.

8. **User recipes are out of the mechanism by construction.** The
   `removed` sets and overlays cover upstream `recipe_id`s only; a
   household recipe stays visible under EVERY restriction because no
   upstream re-authoring exists to display instead of its authentic text
   (ADR-0054's authored-prose rule). `.agents/skills/mealime-add-recipe/`
   documents the workflow for authors who want a restricted variant: add
   it as a SEPARATE household recipe using the catalog's substitution
   vocabulary.

9. **Units (deliberate, per the owner's directive).** The archive is the
   account's US render, so overlay quantities are upstream's US spellings
   carried verbatim (`15 oz`) — the app's `localizeQuantity` passes US
   strings through unchanged, so a device reading imperial displays the
   rework exactly as upstream wrote it; a device reading metric sees the
   US spelling on reworked docs. Re-authoring the quantity into the
   catalog's metric spelling was considered and rejected: it would be
   exactly the re-authoring this pipeline refuses, and the grocery path
   (which owns arithmetic) already scales from the BASE doc's metric
   quantities.

## Consequences

* The feature is fully offline: the artifacts ship in the bundle, the
  archiver and doc cache live outside the repo, and no app code ever
  requests a mealime.com host (the e2e block enforces this).
* The overlay payloads are lazy: only an install with an active
  restriction fetches `restriction_sets.json` (78 KB), and only per active
  slug (`gluten-free.json` is 2.8 MB — the rest are ≤ 0.8 MB). A failed
  fetch degrades to the base catalog and retries on the next call; it can
  never take the catalog down.
* `--check` (wired into `test:data` via `test_build_restriction_sets.py`)
  is offline at two tiers: committed-vs-catalog goldens always; a
  byte-identical cache-only rebuild when the local archive is complete.
  A CI runner without the archive skips the archive-faithfulness tier
  rather than failing.
* The stale golden the brief asked for ("every overlay doc's line_items
  count equals the base doc's count") is FALSE on the real archive — the
  gates that replace it are join correctness (`doc.recipe_id`), the
  payload-census drift warning, and the build-time assertion that a
  restricted render never ADDS recipes.
* The archived US/6 renders and the committed metric catalog can drift as
  upstream publishes: rerunning the archiver + builder refreshes both,
  and the `all-free`/`none` baselines re-pull with them.

## Alternatives considered

* **A swap table interpreted at runtime** (name pairs per restriction).
  Rejected: upstream's substitute choice is per recipe (`tamari` in one
  doc, `coconut aminos` in another; shrimp becomes eggs, a tortilla
  becomes lettuce + avocado), the counts move, and the step prose names
  the substitute. Any table we derive would be a lossy guess wearing
  upstream's authority.
* **Runtime fetching of restricted renders.** Rejected outright — the app
  is offline-first and `expectZeroMealimeRequests` is load-bearing.
* **Metric re-authoring of overlay quantities at build time.** Rejected
  (Decision 9): not our authoring to do, and the golden pins the verbatim
  US spelling.
* **Restriction as a plan-state filter** (hide planned restricted
  recipes). Rejected: it would orphan plan entries and grocery state the
  moment a chip toggles; discovery-only keeps every key alive.
