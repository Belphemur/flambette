# ADR-0099: Ingredient detail data corpus — offline images + curated substitutions

Status: accepted — data slice of the issue #101 ingredient detail view (2026-10-28). The UI slice (bottom sheet, surfaces, plan lookup) gets its own record when designed.

## Context

Issue #101 asks for a detail view when tapping a grocery ingredient: image
preview (visual identification), substitutes, and links to planned recipes
using it. The catalog provably carries NONE of the first two dimensions —
negative census, established before design:

- **Images:** zero ingredient imagery in the corpus. `ingredients.json`
  (871 rows) carries only `name/nameKey/category/unit`; the only surviving
  Mealime image URLs are 17 entries in the bundled `user_data.json` snapshot,
  UUID-keyed with no name→URL mapping. The Mealime API is dead (503
  post-shutdown); the CDN still serves but is UUID-addressed, so it cannot be
  re-mapped at scale.
- **Substitutes:** the corpus has no "instead of this, buy that" dimension.
  13 real substitute strings survive in the snapshot extras; the ADR-0059
  restriction machinery carries 62 verified swap pairs (41 distinct "from"
  ingredients), several of which are restriction-context artifacts (e.g.
  `all-purpose flour → black pepper`).

Owner decisions (2026-10-28): build the images corpus from TheMealDB with
attribution; author substitutions as LLM-drafted candidates curated by the
owner before commit; ONE fused artifact (not per-ingredient files) lazy-loaded
only by the detail sheet; images served by the app as optimized webp, **never
from the outside**; TheMealDB credited inside the ingredient page itself.

## Decision

- **Source: TheMealDB** (themealdb.com) — 992 ingredient names, 700×700
  transparent PNGs keyed by plain lowercase name, live at fetch time.
  Licensing: free at point of access per themealdb.com/api.php (supporter key
  only required for app-store releases; Flambette is a web app). **The detail
  sheet renders TheMealDB attribution** (owner directive) — the artifact
  carries `source`/`license` and the UI slice must render it.
- **`scripts/fetch_ingredient_images.py`** owns the corpus: fetch phase
  (resumable, browser UA, raw PNGs archived OUTSIDE the repo at
  `mealime-media/raw_ingredient_images/` — the CDN could die anytime, so raws
  are archived at build time) and an offline derive phase (400px q72 webp →
  `public/img/ingredients/`, fused artifact). Fetch and derivation stay
  separate so a re-derivation never needs the network.
- **Matching:** layered candidates over the closed 992-name set (normalize →
  comma/slash qualifier strip → head-noun-LAST token preference → variant
  plural/singular forms) + a hand-verified `ALIASES` table for vocabulary
  pairs the matcher cannot bridge (corn→sweetcorn, ketchup→tomato ketchup,
  eggplants→aubergine — TheMealDB is British-leaning). Every alias target is
  asserted present in the fetched list, so vocabulary drift fails loudly.
  Head-noun-LAST ordering is load-bearing: "butter lettuce" must match
  lettuce, not butter.
- **Owner-curated `EXCLUDES`** (7 rows, rationale inline in the script):
  matcher matches that are WRONG rather than adjacent (butter bean→butter,
  cream of tartar→cream, ginger ale→ginger, sugar snap pea→sugar, vanilla
  protein powder→vanilla, cheese ravioli/tortellini→cheese) render the aisle
  glyph instead. A future matcher change cannot silently resurrect them.
- **Substitutions:** `scripts/ingredient_substitutions.json` is the curated,
  committed table — LLM-drafted candidates (2–3 kitchen-common substitutes
  per ingredient) over three seed layers (restriction-swaps, snapshot, draft),
  owner-curated 2026-10-28 (16 uncertain rows resolved; alfalfa sprouts adds
  soybean sprouts; smoked salmon → smoked trout, prosciutto (different
  flavor)). Keyed by `nameKey` (the grocery.ts rule), `displayNames` preserves
  the taxonomy spellings that merged into each key (11 singular/plural
  collisions, e.g. egg/eggs).
- **ONE fused artifact: `public/data/ingredient_detail.json`** —
  `entries: {nameKey: {image?, substitutes?}}` over the 871-row index
  universe. 661 entries (601 with images, 338 with substitutes). The detail
  sheet lazy-imports this single chunk (`import()` — same pattern as
  `ingredientSuggestions.ts`'s `loadIndex`); the main bundle never carries it,
  and users who never open the sheet never load it. Measured: ~76 KB raw /
  ~15 KB gzipped, one-time, browser-cached.
- **Images are served by the app as optimized webp, never from the outside**
  (owner directive): the artifact stores local paths only and carries zero
  remote URLs — asserted by the golden.

## Measured

- Recipe taxonomy (349 display names): 83.7% matched by the layered matcher
  alone; +13 aliases → 88% with an image; the remainder (brand names, most
  dressings/sauces, fish varieties, and — surprisingly — cauliflower, which
  TheMealDB genuinely lacks while carrying three broccoli varieties) render
  the ADR-0076 aisle glyph + hue, so the section never looks broken.
- Grocery index (871 nameKeys): 601 with images (69%), 338 with substitutes,
  661 entries total.
- CDN 404s exist WITHIN the mealdb list (rye flour, swiss cheese, tapioca,
  …): listed but with no image file. Those nameKeys land in `unmatched`, and
  `images + unmatched` must always total the index (golden-pinned).

## Golden

`scripts/test_ingredient_detail.py` (wired into `bun run test:data`) reads
the COMMITTED artifact only — CI never fetches and never sees the raw
archive. Asserts: shape/count self-consistency, every image file exists as a
real webp, ZERO remote URLs in the whole artifact, substitutes rows
byte-match the curated table (the artifact is a fusion — a table edit flows
through the generator, never a hand-edit), every entry key is a real index
nameKey, no orphan webp, attribution present. Mutation-proven red once before
trusting green. The dev-time freshness gate is
`fetch_ingredient_images.py --check` (local, needs the raw archive; mirrors
the derive path's no-image handling exactly).

## Consequences

- The CDN's eventual death changes nothing: raws are archived outside the
  repo and the committed artifact regenerates offline.
- New ingredients (user recipes, supplemental rows) appear glyph-only until
  matched or aliased; the `review` array in the artifact lists every
  first-token-fallback match (adjacent-not-exact) for periodic owner
  curation.
- The UI slice still needs its own design record: bottom sheet on the
  AppModal machinery (ADR-0084 patterns), tap-to-open on BOTH GroceryTab and
  ShopView rows, structure per the issue's reference mock (identity + photo →
  "Need a substitute?" → "You'll use this in…" — the last fully derivable
  from the plan), and the TheMealDB credit line.
