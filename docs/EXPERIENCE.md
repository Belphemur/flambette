# The Flambette Experience v2 — "Warm Culinary Paper"

Status: DRAFT for owner review (2026-10-09). Defines the redesigned
experience end to end. Upon acceptance it is the contract that DESIGN.md v2
and every implementation slice implement; the Stitch project "Flambette
Recipe App" (14 screens: 7 desktop + 7 mobile, all COMPLETE) is its
rendered reference. Companion decisions: ADR-0065 (full-bleed chrome +
sunken fields — folded in as slice 1) and the token-adoption ADR-0067.

## 1. The feeling

An editorial culinary notebook, not software. Cream paper stock, espresso
ink, ripe-tomato intent. Cards are index cards resting on a counter —
keylined, never floating on shadows. Photography is the appetite; type is
the voice; tomato is spent only where the user commits. Everything is
reachable one-thumbed on a phone in a kitchen; on desktop the extra width
buys calm two-column composition, never density.

## 2. The flagship: recipe detail + cooking

The owner picked the Recipe Detail & Cooking Mode screen as the standard
every other surface must match:

- Desktop: 4:3 photograph BESIDE the intro (never a screen-wide ribbon);
  title, facts and the action panel to its right (ADR-0073's 5/7-col
  grid); ingredients and instructions in a ~1:1.5 two-column reading
  layout below — ingredients as a CHECKLIST card (right-aligned mono
  quantities, success check state, "Mark all ready", ephemeral
  device-local state).
- Mobile: photo → title/facts → actions → ingredients → steps, single
  column, 16px gutters.
- Metadata strip on the intro card: total time, per-serving calories
  (never scaled), household rating, servings stepper, sodium droplet —
  real catalog data only (ADR-0073's rejected-fictions list).
- Measured-amount chips beneath steps; one-tap timers always visible once
  running; servings stepper on the facts row; detail previews steps as
  numbered cards whose timer-hint steps carry the inline timer.
- ONE filled intent per surface, and the intents split by colour: TOMATO
  = begin (Start cooking / Cook again), SUCCESS = complete (Finish
  cooking, ADR-0072); favourite is the espresso-disc heart over the
  photo; everything else outline/tonal.
- Cooking mode is a different room: chromeless, 672px measure, one step at
  20px, thumb controls. Detail teaches; cooking commands.

## 3. Colour — the Stitch system, adopted (owner ruling)

Repo keeps token NAMES (`bg-brand`, `bg-surface-raised`, `text-hue-fish`…
all keep working); VALUES re-point at Stitch:

| Token (repo name) | Old | New (Stitch) |
| --- | --- | --- |
| `surface` (page) | `#FFF8F0` | `#FBF8F2` paper-base |
| `surface-raised` (cards) | `#FFFFFF` | `#F4EFE6` paper card |
| `surface-sunken` (bands/fields) | `#FFF0E6` | `#EDE5D8` paper-elevated |
| `border` | `#E5D8CB` | `#E3D8C8` border-warm |
| `border-strong` (control keyline) | `#8C7A6B` | measured from Stitch's `#D3C4B0`–`#C9B8A4` family (3:1 gate) |
| `text` | `#292524` | `#1C1C18` on-surface |
| `text-muted` | `#63574E` | `#59413C` on-surface-variant |
| `brand`/`brand-*` | — | unchanged (`#B3381F` / `#8E2C17`) |
| hue families (food identity) | — | unchanged, byte for byte |

New families to add (each with a dark pair, WCAG + ΔE measured per the
hue-collision procedure before shipping):

- **Saffron `#D97706` (+ soft)** — timers/heat/tips. A non-food family;
  measured against `warning` `#9A3412` and `meal-breakfast` `#946200`.
- **Roasted espresso `#2B1E1A`** — the SECONDARY surface: bottom-nav bar
  and photo-scrim discs in BOTH themes (dark chrome in light mode, as the
  reviewed screens render it).
- **Popover white + warm ambient shadow** — elevation level 2 only
  (popovers/sticky bars): `0 8px 24px -4px rgba(43,30,26,0.08)`.
- **Espresso scrim `rgba(33,22,19,0.45)` + 6px blur** — modals/sheets
  only; the no-global-blur rule stays, the exception becomes explicit.

Elevation model is TONAL PAPER LAYERING: cards get NO drop shadow (keyline
only); white + soft shadow is reserved for popovers. Dark mode keeps the
`.dark` variable-flip architecture; dark ramps are re-tuned to the new
paper and every affected pair re-measured.

## 4. Typography — self-hosted Plus Jakarta Sans + JetBrains Mono

- PJS: headlines, labels, body. JBM: the DATA voice — quantities, times,
  dates, counts, room codes, aisle indices, versions. Nothing else.
- Both SELF-HOSTED (owner ruling): subset WOFF2 in-repo, `@font-face`,
  `font-display: swap`, zero network requests; licences ship alongside.
- Scale adopts Stitch's ladder (display-lg 48 … label-sm 12, including
  `headline-lg-mobile` 28px); `cooking-step` 20px/1.6 survives.
- Supersedes the system-ui-only rule (recorded in ADR-0066).

## 5. Navigation & chrome

- Header: full-window paper band (ADR-0065), content aligned to the
  1100px container; wordmark left, room chip + version + theme right;
  search well right on EVERY tab (ADR-0070 Addendum 2 — searching
  elsewhere routes to Recipes; the `?` tips affordance rides it).
- Bottom nav: five labelled tabs, 56px, ≥44px targets, on the roasted-
  espresso bar; active tab keeps tinted backplate + `aria-current`; hover
  lifts the icon 2px (pointer-only, reduced-motion safe).
- Fullscreen modes (cooking, shop): no header, no nav; shop carries its
  exit bar + honest progress.

## 6. Component language

- Cards: paper fill, 1px warm keyline, 12px radius, NO shadow; hover
  strengthens the keyline (desktop only), never lifts.
- Chips/pills: 9999px; idle = 8% semantic hue tint + hue text (identity at
  rest); SELECTED = brand-tint + brand-text (selection is always brand,
  never a food hue); exclusions keep explicit wording; label never drops.
- Fields (ADR-0065): sunken wells — paper-elevated fill, control keyline,
  12px radius, 44px height, tomato focus keyline under the global ring.
- Checklists: 20px boxes (6px radius, warm border); checked = SUCCESS
  fill + struck muted text (completion is the success family — ADR-0072;
  never a food hue, never tomato). Preference toggles are not
  checklists and keep their neutral control styling.
- Quantities/times/dates/counts render as right-aligned JetBrains Mono
  data badges in list rows (the §4 data voice, ADR-0071/0073).
- Grouped lists render as INDEX CARDS: rows inside one rounded
  surface-raised card with keyline dividers; the header is a band with
  the group's hue glyph, name, and mono count pill; walk-order groups
  carry an aisle index (ADR-0071). Every tab opens with an EDITORIAL
  header block (eyebrow → H1 → derived-from subtitle, real counts only
  — ADR-0075's grammar inventory).
- Buttons: primary tomato 12px radius (pill allowed on compact), hover
  `primary-strong`, active scale 0.98 (reduced-motion: colour only);
  secondary outline; destructive danger outline + confirm.
- Numbers are always JetBrains Mono/tabular.

## 7. Surface walk-through (desktop AND mobile per surface)

- Explore (ADR-0074): search well + sort MENU (check on active) +
  quick-filter pills + meal-type pills (ADR-0043 data), 2/3/4-col photo
  grid (1-col <360px), mono count line when filtered; card overlays =
  espresso favourite/rating discs only, type chips stay on the facts
  row; sodium never on cards; NO "offline" copy (owner ruling).
- Plan: unscheduled meal rows (thumb, title, stepper, facts), mono totals
  strip, Auto-Plan carries THE tomato; preview/undo untouched.
- Grocery (ADR-0071): editorial header with derived-from counts; EXTRA
  ITEMS first with add-row (desktop: Quick Entry in the sidebar);
  keylined aisle cards with hue-glyph header bands, aisle indices and
  `N/M` mono pills; checked rows stay IN PLACE (struck, success) —
  Shop keeps the sink; desktop sidebar (contributing meals + ceiling
  explainer, real counts only); room strip only when joined.
- Shop: chromeless; exit + `N/M (pct%)` progress; ≥52px rows; auto-
  collapsed done aisles; extras pinned; no photos; adopts the aisle
  band + qty-badge + success-checkbox grammar (ADR-0075 sweep).
- Cooking: 672px measure, one step, chips, timers, sticky prev/next +
  mono step counter + Finish cooking in SUCCESS (ADR-0072).
- Detail: ADR-0073's composition — checklist card, metadata strip,
  step-list preview; rejected render fictions never ship.
- History: plan-grouped log, mono dates/counts, period pills, sharing
  note, honest empty state, no gamification.
- Settings: identity / household sync / preferences / backup / about;
  danger leave; validate-first import.
- Room: live chip → roster sheet (hashvatars); one-tap share link.

## 8. What does NOT change

Behaviour, routes, stores, room/relay semantics, backup registry,
derived-grocery aggregation, nutrition rules, offline e2e enforcement,
`data-test` hooks, ADR-0016's Pixel 7 tab fit, cooking's measure.
A re-skin + recomposition, not a rebuild: e2e stays green; re-pin only
layout assertions that read old geometry.

## 9. Implementation slices (pi-supervisor phases)

1. Foundation: fonts + token migration (DESIGN.md v2, `@theme`, `.dark`,
   DTCG, parity tests) + chrome (full-bleed header, espresso nav).
2. Core language: card/chip/field/checklist/button classes app-wide
   (ADR-0065's field class lands here).
3. Explore + Recipe detail/cooking re-skin (the flagship).
4. Plan + Auto-Plan dialog re-skin.
5. Grocery + Shop re-skin.
6. History + Settings re-skin.
7. Dark-mode + contrast sweep + screenshot boards (both themes, all
   surfaces) + full gate run. The boards live in
   [`docs/design/boards/`](design/boards/MANIFEST.md) (28 captures, both
   themes, desktop 1280 + Pixel 7 390) and the measured WCAG sweep is
   `scripts/contrast_sweep.mjs`.
8. Grocery reading surface (ADR-0071): in-place checked state, editorial
   header, aisle cards + indices, qty badges, desktop sidebar, room
   strip; sink specs rewritten; Shop keeps the sink.
9. Recipe detail composition (ADR-0073) + cooking nav bar + success
   finish (ADR-0072).
10. Explore archive composition (ADR-0074): sort menu, overlay grammar,
    meal-type pills; search-tips contextual reveal (ADR-0070 addendum).
11. Cross-surface consistency sweep (ADR-0075): the grammar inventory
    walked over ALL surfaces, sweep table extended (success pairs),
    boards re-captured and RE-INSPECTED, full gate, per-rule checklist
    in the report. Workers read the target screens from the Stitch
    project (MCP) before each slice.

Each slice: locked ADR/DESIGN.md authority → implementation → review
campaign → owner visual pass. Gates: design.md lint 0/0, build, unit,
full e2e serially, screenshots actually inspected.

## 10. Open items for the owner

- RESOLVED 2026-10-09 (slices 8–11 rulings): `border-strong` =
  `#947E64`; espresso bottom nav in light mode CONFIRMED (shipped,
  slice 1); saffron CONFIRMED (shipped); grocery checked state =
  success family (ADR-0072); reading/task split for Grocery/Shop
  (ADR-0071); no "offline" copy on Explore (ADR-0074); search-tips
  contextual reveal, auto-expand stays forbidden (ADR-0070 addendum).
- Standing: Stitch fictions (device-id string format, v0.11.1 badge,
  invented recipes) reconcile to the REPO's real data, never the render.
- Stitch's own CSS uses BOTH the M3 ladder and our old hexes in prompt
  echoes (`#FFF8F0`, `#E5D8CB`) — the ADOPTED values are §3's table; the
  repo is authoritative where a render disagrees.
