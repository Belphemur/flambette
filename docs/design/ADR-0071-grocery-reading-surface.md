# ADR-0071: Grocery tab is a reading surface — checked rows stay in place

Status: accepted (2026-10-09)

## Context

The Stitch grocery renders (desktop "Derived Grocery List", mobile
"Grocery List") prescribe a structure the slice-5 re-skin deliberately
did not reach: it re-painted the existing layout rather than recompose
it. Four structural deltas are in the renders:

1. **Checked rows stay in place**, struck through, where they were
   checked — while the repo's ADR-0008 addendum + `sinkChecked`
   (`src/lib/sink.ts`) sink completed rows below the open ones so the
   next tap is always at the top of its group. The sink is shared with
   ShopView and e2e-pinned.
2. **Editorial header**: an eyebrow, a `Grocery List` H1 and a
   derived-from subtitle ("Derived from N planned meals (M servings)…")
   — the list currently opens on a bare Start-shopping button plus a
   sticky count toolbar with no derived context.
3. **Aisle sections as index cards**: rows inside one rounded
   `surface-raised` card with keyline dividers; the header is a BAND
   carrying a food-hue icon, the section name, an aisle index
   ("Produce (Aisle 1)") and the `N/M` mono pill — the current header is
   a bare uppercase micro-label with a chevron.
4. **Desktop sidebar (lg+)**: Contributing Meals (thumbnails, servings,
   grocery-line counts), a zero-waste ceiling explainer, and the Quick
   Extra Entry relocated into it; plus a live room strip (sync dot +
   room code + shopper count).

The owner ruled on each fork (2026-10-09): checked-in-place on the
Grocery tab with the sink KEPT in ShopView; collapse RETAINED (restyled,
ADR-0008 survives); the desktop sidebar adopted in full; the room strip
shown only when a room is joined.

## Decision

**The Grocery tab is a READING surface; Shop mode remains a TASK
surface.** The two surfaces now diverge deliberately in row behaviour
and re-converge in visual grammar (ADR-0074):

- **Checked-in-place on Grocery.** `GroceryTab` stops calling
  `sinkChecked` — a checked row stays where it is, struck through,
  muted. `sinkChecked` remains a pure lib consumed ONLY by ShopView
  (there the next-tap-at-top rule is the point of the surface). No mode
  parameter: one caller, one behaviour — a mode knob for one call site
  is an abstraction with a single user.
- **Collapse survives restyled** (ADR-0008 in force): the header band
  keeps its chevron, `aria-expanded`, `N/M` pill and the ONE done-map
  auto-collapse watcher for both store sections and extras
  sub-sections. The band adds a food-hue icon and the aisle index.
- **Aisle numbering** is derived from `STORE_SECTIONS` order (1-based)
  and rendered as muted parenthetical text — never hand-numbered.
  Extras sub-sections share the treatment but carry no number (they are
  a view, ADR-0050 §2).
- **Quantity moves right**: the row renders name left, the line's
  display quantity as a right-aligned JetBrains Mono data badge
  (§4's data voice). The provenance pill stays a flex sibling OUTSIDE
  the truncating name span (e2e-pinned geometry); merged-line text
  stays verbatim per ADR-0017 — the badge is a RE-RENDER of
  `line.text`, not a new parser.
- **Editorial header**: eyebrow + `Grocery List` H1 + derived-from
  subtitle built from real counts (`plan.plan.length`, servings,
  ingredient count). The sticky progress toolbar is restyled as the
  progress card (mono counts, percent, bar) and stays sticky; the
  Clear-checked action stays confirm-first.
- **Desktop sidebar (lg+ only, sticky)**: Contributing Meals card
  (thumbnail via the shared `imageSrc`/`onImgError` path, per-meal
  servings and grocery-line counts computed from the SAME aggregation
  pass — never a second aggregator), a zero-waste explainer that states
  ADR-0017's ceiling rule in prose without invented numbers, and the
  Quick Extra Entry (the `IngredientAutocomplete` add-row relocates
  there; mobile keeps it under the extras header).
- **Room strip**: rendered only when a room is joined, from real
  ADR-0063 presence data (code + live member count); hidden solo, never
  awaited on a render path (ADR-0019).
- **Rejected fictions** (renders only): "Est. Market Time ~25 mins"
  (no data), per-item flavour sublines ("Pre-washed clamshell
  packaging" — invented), "Custom Note" pills, per-row "Cook Again"
  (re-cook is detail/cooking's flow), gamification of any kind.

## Consequences

- Grocery e2e specs that assert the sink (checked-last ordering) are
  REWRITTEN to assert in-place + strikethrough; ShopView's sink specs
  stay untouched. `sink.test.ts` stays green — the lib is unchanged.
- The sidebar makes `useGroceryList` expose per-meal line counts
  (derived in the existing pass); the sidebar renders from that, not
  from a new walk of the catalog.
- Dark mode: every new surface uses the `.dark` flip tokens only
  (success pair included, ADR-0072); the sweep + boards re-run.
- The tab gets taller on desktop (sidebar cards) — no width-canvas
  change; `max-w-app` shell rules untouched.

## Alternatives considered

- **Keep the sink everywhere** (Stitch look only): rejected — the owner
  ruled the reading/task split; also leaves the render's clearest
  behavioural delta unadopted.
- **In-place everywhere**: rejected — ShopView's sink is load-bearing
  for a live shopping run (thumb reach, next-tap-at-top).
- **Mode parameter on `sinkChecked`**: rejected — one caller per
  behaviour; the divergence is at the VIEW, documented here.
- **Drop collapse**: rejected (owner) — ADR-0008's auto-collapse is
  pinned and useful with many sections; the render's static look is a
  mock's convenience.
