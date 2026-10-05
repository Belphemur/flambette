# ADR-0054 — catalog profiles: units × servings are ACCOUNT settings, not per-recipe variants

* Extends: ADR-0047 (unit system), ADR-0009 (linear servings scaling), ADR-0017 (container units)
* Status: **Proposed**
* Companions: `scripts/archive_catalog_profiles.py`, `../mealime-media/raw_profiles/` (gitignored archive)

## Context

The owner's standing question about the frozen catalog is what a *variant* is.
The working assumption was that variants encode serving size and/or a
metric-vs-imperial choice, and that the app should offer a "pick the other
variant" control. The committed catalog appeared to settle it negatively:
`units: "Metric"` and `serving_count: 6` on all 2 759 docs, exactly one
variant per `recipe_id` (ADR-0047's Context, and the census recorded in the
`mealime-catalog-data` skill).

That negative finding was drawn from ONE pull and never tested against a
second. Three live pulls on 2026-10-05, driven by the owner's own account
settings, change the picture in a way that matters:

| pull | settings | payload | measured `units` | measured `serving_count` |
| --- | --- | --- | --- | --- |
| committed | metric, 6 | 2 759 variants | `Metric` | 6 |
| `us-6` | imperial, 6 | 2 759 variants | **`US`** | 6 |
| `metric-4` | metric, 4 | **2 760** variants | `Metric` | **4** |
| all six | 2×3 matrix | 2 759–2 760 | `Metric`/`US` | 2 / 4 / 6 |

The owner later surfaced `POST /api/v2/set_profile`, which switches the account's
render programmatically (`unit_family_id` 1 = Metric, 2 = US;
`serving_count` ∈ {2, 4, 6}). `scripts/archive_catalog_profiles.py --all` now
drives it, so the whole matrix is archived under
`../mealime-media/raw_profiles/` (~90 MB): metric-{2,4,6} and us-{2,4,6}.

So the unit system and the serving count are **real, and they change the data**.
The committed catalog is not "the catalog"; it is one *render* of it.

### What the pulls actually prove

1. **`units` is `"US"`, not `"Imperial"`.** A doc fetched from the imperial
   profile carries `units: "US"` and imperial quantities: `15 oz rotini pasta`,
   `3 (15 oz) cans`, `1 ½ pints`. The catalog does not spell the system the way
   our settings label does.

2. **The same recipe renders differently, and the ingredient list survives.**
   Recipe 2195 in `metric-6` (committed) vs `us-6`: identical `name`, identical
   14 line items in the same order, identical `ingredient_name` on every one.
   Only the quantities change — `283 g rotini pasta` → `15 oz rotini pasta`,
   `2 (398 ml) cans` → `3 (15 oz) cans`. Over 50 recipes sampled across the
   metric/imperial boundary, **50/50 had byte-identical ingredient lists.**

3. **The imperial render is not a mechanical unit swap of ours.** Over the
   FULL corpus (2 759 docs joined on `recipe_id`), **187** unique
   `(metric, US)` quantity pairs differ. Running our own ADR-0047
   `localizeQuantity(..., 'imperial')` over them reproduces **124/187 (66.3%)**
   exactly. The 55 misses are three real classes:

   - **Rounding differs.** Upstream rounds to a human fraction (`0.341 kg` →
     `¾ lb`, `1.7 kg` → `3 ¾ lb`); `formatAmount` gives `0.8 lb` / `3.7 lb`.
     Note this cuts both ways — upstream itself is inconsistent, rendering the
     same `1 ½ (398 ml) cans` as `15 oz`, `14.5 oz` and `13.5 fl oz` in
     different recipes.
   - **Package labels are not conversions.** `1 (398 ml) can` → `1 (15 oz) can`
     is a real product's label. We cannot derive a purchasable label from a
     volume; only the catalog knows it.
   - **Container nouns inflect.** `1 ½ (113 g) pkg` → `1 ½ (4 oz) pkgs`.
   - **Container nouns are re-worded.** `1 ½ small pkgs` → `1 ½ pints`,
     `3 small pkgs` → `3 pints` — upstream swaps the container noun entirely
     rather than converting a number.

   66.3% is the honest number and the golden
   `scripts/test_catalog_profiles.py` pins it as a REGRESSION FLOOR (0.60),
   because divergence from upstream's authored strings is legitimate: a package
   label is a product fact and pluralisation is upstream's copy decision.

4. **`serving_count` is a re-render, and our linear factor reproduces most but
   not all of it.** Between the committed `metric-6` and the archived
   `metric-4` render of all 2 759 shared recipes: identical ingredient names
   throughout, and our `factor = 4/6` reproduces upstream's 4-serving amount on
   **90.9% of parseable line items** (tolerance 1%; 93.0% once upstream's
   quantization vocabulary is applied). The instruction prose is **not**
   derivable: only **269/2 759 (9.7%)** recipes have identical step text, and
   the differences are re-authored singular/plural and vessel wording (`lemon`
   vs `lemons`, `a medium saucepan` vs `a large pot`), not a numeric rescale —
   replacing every number by `n × 4/6` explains only 3 of 220 differing steps.
   Upstream re-authors the sentence; we would have to keep both strings.

### How upstream's render actually rounds (measured, full matrix)

The two-serving render decodes the formula. Upstream does NOT scale grams or
millilitres at all — it keeps an **ounce/floz base and reconverts**: `0.68 kg`
is exactly 24 oz, `2129 ml` exactly 72 fl oz, `510 g` = 18 oz. At 2 servings
(`factor = 1/3`) `1420 ml` = 48 fl oz → 16 fl oz → **473 ml**, which is
`16 × 29.5735` rounded — our linear grams give `473.3`, same answer, simpler
model. Where the two differ is presentation only:

| rule | example (metric-6 → metric-4/2) |
| --- | --- |
| container counts round to nearest ½ | `1 small pkg` → `½` (0.667 → 0.5, both 4sv AND 2sv) — 22×22 confirmed uniform |
| integer counts floor when ≥ 1, keep fractions below | `2 cloves` → `1` (1.33 → 1); `1 ½` cucumbers → `½` (0.5) |
| cups round to the nearest ⅛ | `½ cup` → `¼` |
| g / ml round to integers | `43 g` → `28 g` (28.67), `1420 ml` → `947 ml` |
| kg keeps 2–3 decimals | `1.02 kg` → `0.68 kg` |
| small ml re-vocabularies to cup fractions | `90 ml` → `¼ cup` |
| seasoning exponent — REJECTED | `sesame ginger dressing` `¾ cup` → `½` → `¼`, LINEAR |
| `unsalted` / `ginger root` — REJECTED | our `isSeasoning` keyword `'salt'` substring-matches `unsalted` (460 line items) and `'ginger'` matches the fresh root (311); upstream scales both linearly |

**Verdict on "is our serving calculator better":** for AMOUNTS the two agree in
shape, and ours is better where it matters — we keep metric linear instead of
detouring through an ounce base (mathematically identical, fewer moving parts),
we do not invent the re-authored prose, and we do not carry two `isSeasoning`
false positives (`unsalted`, `ginger root`) that would under-scale 771 real
line items. Upstream's per-recipe quantization (container counts to ½, counts
floored, cups to ⅛) is a presentation nicety our display could adopt as a
formatting layer without touching stored values; it is the one piece of the
render worth borrowing, and it is the same vocabulary ADR-0009/0017 already
leave room for. The sub-linear seasoning rule is OUR invention and stays
(ADR-0009's intent), but `isSeasoning` needs the two exclusions above.

5. **Identity is the load-bearing correction.** `variant id` and
   `published_recipe_uuid` are **re-issued on every call**: two pulls with a
   byte-identical request body returned **zero** id overlap and zero uuid
   overlap, while all 2 759 `recipe_id`s matched. So `variant id` is a
   per-render handle, not a recipe identity. This is a live hazard, not a
   theoretical one — `merge_builder()` in `scripts/sync_catalog.py` merges on
   `variant_meta[].id`, so running a sync today against a live payload would
   **append 2 759 brand-new ids for recipes we already have and grow the
   catalog to 5 518 entries**, every one of them a duplicate recipe.

6. **A doc is immutable once fetched.** Re-fetching a `published_recipe_uuid`
   after the account setting changed still returned its ORIGINAL `units` and
   `serving_count`. A profile is therefore stable and archivable — but only if
   archived, because the uuid that named it is not reproducible.

7. **The settings are account-wide, not per-request — but `set_profile` can
   drive them.** Adding `"units":"Metric"` or `"serving_count":6` to the
   `get_builder_data` POST body changed nothing (byte-identical 676 843-byte
   responses). The render follows the account, and `serving_count` is
   **uniform across the whole catalog** in any one pull (6 on all 2 759,
   4 on all 2 760) — never per recipe. So the API cannot express "a 4-serving
   variant of this one recipe"; but `POST /api/v2/set_profile` DOES move the
   account between renders, which is how the matrix archive was built and how
   a future profile refresh is scriptable with no manual clicking.

## Decision

**A "variant" is one render of the catalog under one account setting
(`units` × `serving_count`), not a per-recipe choice. Keep exactly one profile
in the app; archive the others as reference truth; stop keying anything on
`variant id`.**

1. **The app ships ONE profile, and it stays the metric/6 render already
   committed.** Serving size and unit system remain display-time transforms
   (ADR-0009 linear, ADR-0017 CEIL-merge for containers, ADR-0047 read-time
   conversion). This ADR does not change any runtime behaviour; it corrects the
   *record* of why that is the right shape.

2. **Archive the whole 2×3 matrix, outside the repo, keyed by uuid.**
   `scripts/archive_catalog_profiles.py --all` drives `set_profile` through
   metric/US × 2/4/6 and writes
   `../mealime-media/raw_profiles/<label>/{builder_data.json,recipes/<uuid>.json}`
   plus an `index.json` per profile recording `units`, `serving_count` and the
   `recipe_id → uuid` map. Committed? No — like `raw_recipes/`, it is gitignored
   truth (~90 MB total). Docs are named by uuid because that is the only handle
   under which a doc can be re-fetched or byte-verified. Images are deliberately
   **not** re-pulled per profile: they are per-*recipe*, so a second profile
   would duplicate 173 MB of webp for zero new pixels.

3. **`recipe_id` is the only stable identity; `variant id` is a per-render
   handle.** Any future sync must key on `recipe_id` and treat the payload's
   `variant id` as disposable. `merge_builder()` is the one place that violates
   this today and is the bug this record exists to prevent from shipping.

4. **The archive's job is to TEST our converters, not to feed them.** The
   imperial renders are ground truth for ADR-0047 (the golden in
   `scripts/test_catalog_profiles.py` pins the 66.3% agreement as a regression
   floor), and the serving renders are ground truth for the scaling below. We
   do not ship upstream's authored strings: each profile is a *second copy* of
   prose ~94% mechanically derivable, they would multiply the doc payload
   ~15 MB raw per profile, and the residue classes (package labels, noun
   inflection, re-authored vessels) cannot be fixed by storing them anyway —
   they can only be *copied*, which reintroduces the drift the transform exists
   to avoid.

5. **Serving count stays a display-time scale; borrow upstream's
   quantization as PRESENTATION, not as data.** Our linear factor matches
   upstream's amounts (90.9% strict, 93.0% with their rounding vocabulary) and
   beats their formula on the details that matter:
   - **We keep metric linear; they reconvert through an ounce base.**
     Same answers, fewer moving parts — the ounce detour is only visible at
     the sub-gram edge.
   - **Their `isSeasoning`-class false positives do not exist here.** The
     `'salt'` substring in `unsalted` (460 line items) and `'ginger'` matching
     the fresh root (311 more, e.g. `ginger root` — a vegetable in upstream's
     render, scaled linearly) would UNDER-scale real ingredients if our
     `isSeasoning` (ADR-0009) adopted them. The fix belongs in
     `src/lib/recipe.ts`: exclude `unsalted` from the `'salt'` match and
     exclude `ginger root` (the fresh root) from `'ginger'` — the dressing
     case (`sesame ginger dressing`, scaled linearly upstream) suggests season
     DESCRIBES, not IS, when embedded in a longer product name; the ADR-0009
     intent covers the spice jar, not the produce aisle.
   - **Worth borrowing, as a display layer only:** upstream's per-recipe
     quantization — container counts round to ½ (`0.667 → ½ small pkg`),
     integer counts floor when ≥ 1 and keep fractions below it
     (`2 cloves → 1`, `1 ½ cucumbers → ½`), cups round to ⅛, g/ml to integers,
     and small ml re-vocabularies to cup fractions (`90 ml → ¼ cup`). This is
     exactly ADR-0009/0017's separation of stored value from display text, so
     it slots in as rendering, never re-authoring.
   - **NOT borrowed:** the re-authored step prose (9.7% identical upstream) —
     a second authored string per recipe for no user-facing win.
   - Deliberate behavioural difference of OURS, kept: the sub-linear
     seasoning exponent + caps is our invention (ADR-0009); upstream scales
     everything linearly. This stays as designed.

### Consequences

- ADR-0047's `units: "Metric"` census stands as a fact about the COMMITTED
  profile, and its "there is no Imperial variant anywhere" claim is corrected
  here: imperial renders exist upstream, they are simply not a per-recipe axis.
- The mm gap found while diffing against the imperial render (below) becomes a
  tracked bug with upstream as the reference, not a guess.
- A future "let me see the imperial wording" feature has a data source at last:
  the archived profile, joinable by `recipe_id`. It is a display-source
  question, not a data-availability one.
- `sync_catalog.py` must be fixed before any live sync, or the catalog doubles.
  That fix is its own change (ADR-0055) and is deliberately NOT bundled here.

## Alternatives considered

- **Ship all four profiles (metric/US × 6/4) into `public/data/`.** Rejected:
  ~15 MB raw per profile, a fourth of it near-duplicate prose, and it makes the
  variant id — the one identifier the API refuses to keep stable — part of the
  app's addressing. It also breaks the e2e-pinned Auto-Plan packs and every
  persisted store key for no user-visible gain.
- **Make servings a stored per-recipe choice.** Rejected: `serving_count` is
  catalog-uniform per pull (6 on all 2 759, 4 on all 2 760). The API cannot
  express a per-recipe serving variant; only our own display scale can, and it
  already does.
- **Adopt upstream's re-rendered US text as the imperial display source.**
  Rejected for now, kept open: it is strictly more faithful (66.3% → 100% by
  construction) and costs one more profile in the bundle. Deferred because it
  roughly doubles doc weight for prose that is ~94% derivable, and because the
  package-label class (`398 ml` → `15 oz`) proves the mapping is a real
  product attribute, not a unit — a fact that belongs in a table, not in a
  second copy of every recipe.
- **Re-derive a profile on demand instead of archiving.** Not possible: the
  uuid that names a doc is re-issued per call (zero overlap between identical
  pulls), so a later pull cannot ask for yesterday's render. Archiving is the
  only way to keep one.

## Open item found while diffing (not decided here)

`mm` is missing from ADR-0047's length table, so imperial mode leaves it
untouched: `6-mm pieces` stays `6-mm pieces` where upstream writes
`¼-inch pieces`. Corpus census over all 2 759 docs: **120 docs, 166 hyphenated
`N-mm` occurrences, 0 bare `mm`, 0 in a line-item quantity** — millimetres
appear only in instruction prose and only hyphenated, which ADR-0047's
`LENGTH_RE` already accepts as a separator had `mm` been in the alternation.

The fix is not one line. `formatAmount` renders 6 mm as `0.2 inch` where
upstream's authored value is `¼ inch`, so closing the gap properly also means
fraction-aware formatting of converted lengths — a converter change, not a data
record. The archived `us-6` profile is what makes it testable:
`scripts/test_catalog_profiles.py` pins the gap at `KNOWN_MM_GAP = 166`, so
the suite stays green while the bug is open and goes RED the moment the count
moves, which is the prompt to fix it and update this record.