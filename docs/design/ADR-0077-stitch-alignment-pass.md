# ADR-0077: The Stitch alignment pass — closing the remaining structural gaps on four surfaces

Status: accepted (2026-10-10)

## Context

ADR-0065..0076 shipped the Warm Culinary Paper redesign: the token system
(ADR-0067), self-hosted typography (ADR-0066), the component grammar
(ADR-0065's field, ADR-0068's tonal layering, ADR-0069's chips), and the
surface compositions — Explore (ADR-0074), recipe detail (ADR-0073), grocery
+ shop (ADR-0071/0076). Those decisions are DONE and reviewed.

Four surfaces still differ from the owner's Stitch renders in STRUCTURE (not
in colour, not in type): the search field is too small a control, and the
recipe detail, History and Settings compositions each leave part of the
render's arrangement unbuilt. This record is the alignment pass on top of
ADR-0065..0076 — layout/composition gap-closing, NOT a re-theme and NOT a
rebuild. No token, store, route, payload or derivation logic changes.

The authority for the diff is the fresh Stitch export (the owner's
attachments, `~/workspace/stitch-refs` and the Stitch MCP project
"Flambette Recipe App" — 14 screens, desktop + mobile for every surface).
The comparison discipline is: diff the mock's STRUCTURE (regions, hierarchy,
grouping, content) against the component, land only real gaps, and never
churn a part that already matches to satisfy a pixel difference.

Recipes search is a size question, not a mosaic question: the Stitch search
band is a single dominant well (leading 22px glyph, `font-body-md` text,
`flex-1` of a full-width bar) while the app renders a 44px/14px well capped
at 288px. The owner's ruling: **the field is the biggest control on the
tab.**

## Decision

### 1. Recipes — the search field is the tab's biggest control

- ONE shared treatment in `RecipeSearchField.vue` (the ADR-0070 two-mount
  component), applied at BOTH mount points, so the header well (lg+) and the
  in-content field (phones) can never drift again.
- Metrics: 48px tall (h-12), `text-base` (16px, the mock's `body-md`), with a
  leading `Search` glyph (Lucide, `aria-hidden`, decorative — the input keeps
  its own `aria-label`). The header well's width cap widens so it reads as
  the primary control rather than a chip-sized affordance.
- The well is still the ONE field language: a `.field.field-search` variant
  in `src/style.css` composed on the existing class (a two-class selector, so
  it deterministically beats `.field`), never a per-view re-spelling and never
  a new colour. Nothing about ADR-0027/0028's quick-filters grid changes —
  the field sits above it — and ADR-0016's 82px/tab bottom-nav fit is
  untouched (the bottom nav is not in this change).
- Rejected from the render: the "Pantry Index • Vol. IV" eyebrow, the
  availability line ("2,759 recipes available offline" — ADR-0074's owner
  ruling) and the "Cookbook Storage Mode Active" footer, all already
  rejected fictions; nothing new is imported.

### 2. Recipe detail — close ADR-0073's composition against the mock

ADR-0073's composition is the base (5/7 intro grid, stat row, one-row
actions, checklist card, numbered steps). What still differs:

- **The metadata strip is a DIVIDED BAND, and it carries the rating and the
  servings stepper.** ADR-0073's own wording already prescribes "total time,
  calories per serving, household rating (ADR-0031 stars), servings stepper"
  on one strip; the implementation split them across two blocks. They become
  ONE keylined strip (`surface-sunken` band, `divide-x` cells, values in the
  mono data voice): total time, per-serving calories (never scaled), sodium
  (the existing ADR-0036 droplet chip), the household's stars, and the
  servings stepper. 3 cells per row on a phone (matching the mobile render),
  4-5 on desktop (matching the desktop render). The stepper keeps writing the
  SAME `servings` ref and the ADR-0037 default, so the checklist scaling and
  Start cooking are unchanged.
- **The action row is ONE row.** `Start cooking` (the one filled tomato) and
  `Add/Update in plan` (outlined secondary) group in a single row — the
  render's arrangement — instead of two stacked full-width buttons. The
  servings row leaves the actions panel (it lives on the strip now); the unit
  system control (ADR-0047) stays in the actions panel, because it is an
  account setting rather than a recipe fact.
- **The step cards take the render's header grammar**: the number badge is an
  ESPRESSO disc (not a brand fill — "one filled intent per surface" is
  ADR-0036's rule, and the tomato is already spent on Start cooking), and the
  step's AUTHORED duration rides the header's right in mono when the recipe's
  ADR-0041 sidecar reports one. Step titles ("Prep Station", "Boil &
  Simmer") are render fiction — the catalog has no step titles — and stay
  OUT; so do the per-step sub-checks. Step prose moves to the render's
  reading size (`body-md` on a phone, `body-lg` on desktop).
- **Measured-amount chips appear under the step text.** ADR-0022 already
  builds these chips for the cooking view; the render puts them on the
  detail's step preview too. They come from the SAME pure
  `measuredChipsForLines` (ADR-0022's "never invent a quantity" rule is the
  lib's, unchanged) — no second implementation, no new maths.
- **The checklist card takes the render's header pill**: an H "Ingredients"
  heading plus a "Scaled for N" pill, and "Mark all ready" becomes the
  card's bottom dotted-underline affordance instead of a header button. The
  checks stay EPHEMERAL view state (ADR-0073's addendum: never persisted,
  never room-synced).
- **Cookware keeps its real data and takes its place in the reading column**:
  `doc.cookwares` already exists and is already rendered, so the render's
  "Cookware Required" module is adopted as a POSITION (under the ingredients
  card in the sticky column), not as its invented items — a specific pan size
  is fiction, `doc.cookwares` is not.
- **OMITTED, deliberately, and already rejected by ADR-0073**: the macro split
  bar and legend (the catalog publishes no protein/carbs/fat), the voice
  listening banner, pro tips, "Beginner Friendly", "Tested N×", the SKU
  string, the photo's provenance caption. The photo keeps its back + favourite
  espresso discs (ADR-0073's disc grammar); the render's top-left category
  chip is a duplicate of the type row already on the sheet, so it is not
  added.

### 3. History — the render's editorial log

- **Editorial head at the display step**: the tab's H1 takes the render's
  weight (`headline-lg`, the display step of the ladder) with the existing
  subtitle — ADR-0075 rule 1's "eyebrow → H1 → derived-from subtitle" pattern.
  No new copy: the subtitle already states what the log is.
- **The sharing note becomes a CHIP ROW** rather than a full-width paragraph:
  sync glyph, the household fact, and the pointer to the Settings toggle
  (ADR-0016 keeps the control itself there — one home, never duplicated).
  Room code in the mono data voice.
- **The summary strip is the render's 3-cell mono strip**: keyline-divided
  cells with UPPERCASE labels and headline-step numbers in JetBrains Mono —
  cooks logged / distinct dishes / most recent. The three numbers already
  exist in `summarizeHistory`; only the arrangement changes.
- **The filter row is pills + search.** The period pills keep their semantics
  (ephemeral, ADR-History note: a question, not a preference) and gain the
  render's search well: a client-side name filter over the visible rows,
  never persisted, never synced, with its own honest "nothing matches" line.
  A filter that matches nothing must not look like an empty log.
- **The timeline keeps the app's plan provenance** (ADR-0034 — a cook event
  belongs to a plan; the render's "Unscheduled Plan #14" numbering is
  fiction) and adopts the render's row grammar: the group header is a
  separated rule carrying the plan title, the mono cook count and the
  absolute date; the meal card carries the "cooked N×" count on the PHOTO in
  an espresso mono disc (ADR-0074's overlay grammar), the mono date, the real
  facts row and the existing `Add to plan` action. The render's "N servings ·
  M min" line is only half-backed by the store (a cook event records no
  servings), so the minutes render and the servings do not — no invented
  number. "Cook Again" maps to the existing Add to plan, and "Export Log" is
  not built (there is no export surface in the app).
- The empty log and the empty WINDOW states keep their own copies (ADR
  empty-window rule): a household whose log is older than the window is not
  a household with no log.

### 4. Settings — the 12-column card grid

- **Editorial head**: eyebrow + H1 at the display step + the existing
  subtitle, over a full-width rule (ADR-0075 rule 1).
- **A 12-column card grid** (`grid-cols-1 lg:grid-cols-12`, `gap-6`) instead
  of one stacked column, and EVERY existing section becomes a card in it:
  no section dropped, none invented. Widths follow the render's arrangement:
  Kitchen Identity (5), Household room (7), Units & servings (6), Dietary
  restrictions (6), Backup & restore (6), Import from Mealime (6), About
  (12).
- **The card grammar is shared**: header row (H2 + one-line subtitle, with a
  keylined icon tile at the right), body, and a footer row separated by a
  warm rule where the card ends in actions. Cards keep the existing index-card
  styling (raised paper + 1px keyline + 12px radius, no shadow — ADR-0068).
- **Kitchen identity is its own card** (the render's col-span-5): the
  ADR-0063 avatar + name field, the shared sanitizer's clamp, and the
  device's room code as the card's mono footer. **Household room is its own
  card** (col-span-7): the live status line with the real peer count, the
  room-code field + Join now, Share room link / New code / Leave, and the
  ADR-0032 cooked-history toggle row. Both are extracted from today's single
  combined "Household sync" card — a regrouping, not a rewrite; every
  `data-test` hook, the feedback modal, the validate-first import and the
  one-shot Mealime import are untouched.
- **OMITTED**: the render's theme toggle in the preferences card (the theme
  is the header's `useDark` control — one home, ADR-0016); the render's
  "up to date" chip (no update service exists); the identity JSON the render
  prints (it is an internal id, not a user-facing string).

## Consequences

- e2e: `browse.spec.ts` (search field at both mounts), `design-visual.spec.ts`
  (detail hero/actions geometry — the action panel stays in the intro's right
  column, the strip replaces the old two-block facts, the step badges change
  fill), `cook-history.spec.ts` / `default-servings.spec.ts` /
  `backup-restore.spec.ts` (history rows, group titles, settings cards).
  Selector NAMES are unchanged; assertions that read old GEOMETRY or old
  copy are re-pinned in the same commit as the change, and the offline
  enforcement and the ADR-0016 tab-fit pins stay exactly as they are.
- One new CSS rule (`.field.field-search`) and no new tokens: every colour,
  fill, keyline and radius comes from the existing `@theme`/`.dark` pairs, so
  dark mode is free (ADR-0036's flip). `palette.test.ts` and the DESIGN.md
  parity tests do not move.
- No ADR-0065..0076 decision is reversed. Where a render and an accepted ADR
  disagree (a macro split bar, step titles, servings on a history row), the
  ADR wins and the divergence is recorded here rather than shipped.
- `docs/EXPERIENCE.md` §2/§6/§7 gain the alignment notes in the same commits
  as the surfaces they describe.

## Addendum (2026-10-10): post-review fix pass — the ONE nutrition bar

Dated change note; Status stays Accepted. The owner reviewed the rendered
detail page against the mock and found two defects this pass fixes:

- **The nutrition split is ONE bar, not three rows.** The alignment pass had
  left ADR-0073's "macro split bar rejected" verdict standing while still
  rendering the macro data as three stacked full-width rows — which is the
  same claim in the wrong composition. The owner's ruling (and BOTH renders):
  one segmented track whose protein/carbs/fat segments sit side by side,
  each width = the macro's fraction of calories, with the mono legend grid
  beneath. This revises the composition; the COLOUR ruling below was
  AMENDED later the same day (owner pixel ruling): the segments wear the
  render's own colours, which ARE this repo's nutrition tokens. The
  legend's grams come from the SHARED
  Atwater constant (`KCAL_PER_G`, lib/nutrition — fraction × kcal / 4|9),
  the same derivation the facts modal uses, never an inline converter;
  sodium rides the legend with its OWN droplet icon and existing hook
  (owner override: sodium is not a calorie macro — it stays separate).
- **The metadata band is the mock's construction, not a stack of padded
  boxes**: the render's band is ONE lighter-base strip (`bg-paper-base`,
  rounded, padded) with GAPped, LEFT-ALIGNED cells — no per-cell
  backgrounds and no divide keylines. (The first draft's divide-trick
  boxes read as cluttered cells — the owner's "looks bad" — and were
  replaced by the plain band.) The meta column stacks at the render's gap
  rhythm.
  A second review pass (same day, with the authoritative render attached)
  then superseded this pass's strip on two points, and the render's meta
  CARD is adopted whole: the tags, the title, the facts band, the actions
  and the nutrition split are ONE raised card, and the band is FOUR
  left-aligned cells — Total Time / Calories (`620` + `kcal/srv`) / Rating
  (the number beside the stars, household rating when one exists else the
  catalog Bayesian mean, the same precedence the stars show) / Servings
  Scaler. Sodium is NOT a band cell (the render's four columns have none,
  and the macro fractions already sum to 1, so a sodium segment has no
  honest width — DATA-REALITY BEATS THE MOCK): sodium reads in the
  nutrition legend in its own droplet hue, with its existing hook.
- **The render's tag-row SKU slot carries nothing.** The SKU string is a
  fiction and stays rejected; the slot is left empty rather than filled
  with the ruleset word, which the meal-occasion icon in the same row
  already states once. The render's labelled pill chips are also not
  adopted: the type chip keeps its documented icon-only treatment
  (DESIGN.md Components, owner-approved — the icon's aria-label is the
  carrier, the tap-reveal bubble is the label's dual).
- **The render's description paragraph is not built**: the catalog carries
  no recipe description field (only per-instruction `secondary_message`,
  which is step prose). The slot under the H1 is already occupied by the
  real cook-history line.
- **The render's third action ("To Grocery") is not built**: the grocery
  list is DERIVED from the plan (ADR-0003) and no add-to-grocery action
  exists on this surface — a third button would invent a bypass of the
  plan derivation.
- **The render's "Daily Value Reference" right label is not built**: the
  catalog publishes no daily-value percentages and none are derivable.
- **Gram math is a lib function, not component arithmetic** (owner ruling):
  `macroGrams(fraction, kcal, macro)` in `src/lib/nutrition.ts` —
  fraction × kcal ÷ the Atwater factor, the arithmetic `macroSplit` runs
  in reverse — unit-tested against the render's own card (44g/48g/26g at
  620 kcal), so no surface re-derives grams inline.
- **Segment colours stay on the BRAND ramp**: ~~owner-confirmed via this
  pass~~ **SUPERSEDED (owner pixel ruling, same day)** — the brand-ramp
  draft produced the red/orange gradient the owner rejected. The render's
  purple/teal/olive/red ARE this repo's own tokens (`nutrition-protein`,
  `nutrition-carbs`, `nutrition-fat`), so adopting them adds
  no hex and risks no ADR-0036 collision — that concern was about a GREEN
  protein segment, which purple never risks. Segments wear the nutrition
  tokens. Sodium is SEPARATE (owner override, same day): it is not a
 calorie macro, so it never joins the bar's segments nor wears a legend
 dot — it keeps its own droplet icon (`hue-sodium`) as before.
- **History rows carry the household's preference controls** (owner
  addition, riding ADR-0031's stores): each cook-history card renders the
  star widget (the SAME `RatingStars` the recipe cards use, `:size="14"`,
  same household-else-catalog precedence) and a favourite toggle — the
  SHARED `FavouriteButton` (the espresso-disc heart the cards and the
  detail sheet already render), EXTRACTED rather than copied a third
  time: one control, one store write, three surfaces. Cook timestamps
  and the date row are untouched. No "To Grocery" button is added to the
  detail (owner: should not be added — the grocery list is derived).
- **Mobile nutrition is the render's stat boxes** (owner's mobile
  render): a "Nutrition Summary / Per serving" header (with the donut
  glyph) and FIVE equal boxes — Energy / Protein / Carbs / Fat / Sodium —
  each a coloured label over a bold value over a unit line (kcal / g / g
  / g / mg — no DV percentages, which the catalog does not publish);
  the split bar + legend stay `sm:`-only. Boxes render one step lighter
  than their card (`surface` on `surface-raised`), like the band.

## Alternatives considered

- **Rebuild the detail from the render**: rejected — ADR-0073's composition is
  already reviewed and passing; the gap is real but small, and a rebuild
  would re-open decisions the owner already ruled on.
- **A second, larger search field class per mount**: rejected — that is
  exactly the drift ADR-0070's "one component, two mount points" rule exists
  to prevent. ONE variant, applied by the one component.
- **Macro split bar on detail**: ~~rejected again~~ **SUPERSEDED (2026-10-10
  addendum, above)** — the earlier "the data cannot support a bar" reasoning
  was WRONG about the data: the catalog publishes `meta.macros` (protein /
  carbs / fats as fractions of calories) alongside `calories` and
  `sodium_mg`, which is exactly what a split needs. The addendum ADOPTS the
  render's one segmented bar (segments = the macro fractions, brand-ramp
  colours, grams in the legend via the shared `lib/nutrition` Atwater
  helper, sodium in the legend). COLOUR AMENDMENT (same day, owner pixel
  ruling): the first draft rendered the segments on the BRAND ramp and
  produced the red/orange gradient the owner rejected — the render's own
  colours are this repo's existing nutrition tokens, adopted verbatim:
  protein `nutrition-protein` (purple), carbs `nutrition-carbs` (teal),
  fat `nutrition-fat` (olive), sodium's legend dot `hue-meat` (red). No
  new hex; the earlier ADR-0036 objection targeted a GREEN protein
  segment (vegetarian collision), which purple never risks. This entry is kept only for the decision
  trail — implement from the addendum, not from this rejection.
- **Group History by DAY like the render**: rejected — ADR-0034's plan
  provenance is the app's real model (a cook event carries its plan id), and
  the render's day grouping would throw that provenance away to match a
  visual.
- **Rebuild Settings as two hero cards only**: rejected — the brief's rule is
  "extend the card-grid pattern to ALL existing sections", so the preference
  and data sections keep their own cards rather than being folded into the
  two hero cards.
