# ADR-0044 — icon-scoped tooltips (hover the icon, not the tile)

* Extends: ADR-0040 (desktop tooltips on food icons), ADR-0036 (DESIGN.md
  "Cards and icon labels"), ADR-0043 (the meal-occasion icons that made the
  bug visible on two surfaces at once)
* Status: **Proposed** (2026-10-02)
* Companions: `src/components/HueIcon.vue`,
  `src/composables/useIconHoverTarget.ts` (new),
  `e2e/design-visual.spec.ts`

## Context

Owner report, verbatim: *"The tooltip should be when hovering the icon not
the recipe … right now it shows when hovering the recipes, the home page, in
the main page. Also no tooltip on the page of the recipe we need it there
too."*

Both symptoms are one bug, and ADR-0040's own component comment predicted it.
`HueIcon`'s host span is `pointer-events-none` so the browse card's stretched
`after:inset-0` link keeps its click path. **A pointer-transparent element
can never match `:hover`.** So the bubble could not be anchored on the host
and was anchored on an ancestor `group/htt` instead:

- On `RecipeCard`, the ancestor carrying `group/htt` is the **card root**, so
  hovering the photo, the title or the padding opened the tooltip. The user
  reads that as "the tooltip belongs to the recipe".
- On `RecipeDetail`, **no ancestor carries `group/htt` at all** (only
  `RecipeCard`'s root and `RatingStars`' inner span do), so the bubble had no
  trigger whatsoever and could never render on the recipe page. This is why
  the detail header shows an icon with an accessible name and no tooltip.

ADR-0040 §1 specified the bubble and the reveal, and chose
`pointer-events-none` for the host; it never specified the *anchor*. That
omission is the defect, and it is why the fix is a new ADR rather than an edit
to ADR-0040.

### Why CSS alone cannot express the requirement

Three requirements are jointly unsatisfiable with the group-hover mechanism:

1. The tooltip must be scoped to the ICON.
2. A click on the icon must still open the recipe (the whole tile is one
   link target; `e2e/design-visual.spec.ts` pins that a click on the icon
   reaches the stretched link and navigates).
3. The host must stay keyboard-focusable, and a focusable node inside a
   link is an accessibility violation — so the icon cannot move *inside* the
   `RouterLink` to inherit its hover region.

Requirement 2 forces the icon's pixels to stay pointer-transparent, and a
pointer-transparent element is invisible to `:hover`. Hence no amount of
Tailwind fixes this; the hit-test has to happen in JS.

Options considered, per the coding-philosophy order (DRY > SOLID > KISS):

| Option | Verdict |
| --- | --- |
| Move the icon inside the `RouterLink` so it inherits the link's hover | **Rejected** — violates (3): a focusable descendant of a link. |
| Drop `pointer-events-none`, make the icon pointer-active | **Rejected** — breaks (2): a click on the icon stops opening the recipe. A real click regression, and it is the behaviour the tile exists to provide. |
| Anchor the group on the icon's facts **row** instead of the card | **Rejected by owner** — "hovering the icon", not "hovering the row"; the row has padding to the right of the last icon. Pure CSS, but wrong scope. |
| **JS hit-test of the icon's rect** | **Chosen** — the only option that satisfies (1) and (2) exactly. |

## Decision

### 1. One shared hit-test, not one per icon

`src/composables/useIconHoverTarget.ts` owns the pointer position. It
installs **exactly one** `pointermove` listener on `window` per mounted
instance of the composable, rAF-throttled, and each subscriber is asked
whether the pointer is inside its rect.

DRY is the reason this is a module and not a `mouseenter` handler on the
icon: there are up to 60 cards × 2 icons on the Recipes tab, and a
per-icon listener is 120 handlers doing the same work. The listener is
**removed on unmount** and is a no-op unless a subscriber is hovering, so
the always-visible cost on a phone is one passive listener that returns
immediately (and the bubble is gated by `@media (hover: hover)` anyway, per
ADR-0040 — a touch device never reaches this path).

### 2. The rect cache is invalidated, never recomputed per move

`getBoundingClientRect()` on every `pointermove` for every icon would force
layout on each mouse move — the classic scroll-jank bug. So the composable
caches each subscriber's rect and refreshes it on `scroll` and `resize`
(passive listeners) plus on `nextTick`, and the cached value is used for the
hit-test. This is a SOLID-over-KISS call: without the invalidation the
cache would go stale and the tooltip would open for an icon that has since
scrolled away, which is a correctness bug, so the invalidation is
load-bearing and stays.

### 3. Hover is additive; focus and the accessible name are unchanged

The bubble reveals on `pointerInside || focusWithin`, still inside ADR-0040's
`@media (hover: hover)` gate, so the touch project stays exempt. The
`group/htt` ancestor mechanism is **deleted**, not left alongside: it is the
stale guard, and leaving it would mean a card hover could still open a bubble
through the old path. `RatingStars`' own `group/htt` is a *different* hover
surface (the rating preview) and is untouched.

`role="img"` + `aria-label` remain the single carrier of the meaning for AT;
the bubble stays `aria-hidden` and `pointer-events-none`. The icon is still
`pointer-events-none` and still `tabindex="0"`, so (2) and (3) both survive.

### 4. Both surfaces, one mechanism

`RecipeCard`'s type + occasion icons and `RecipeDetail`'s header type +
occasion icons all get the tooltip from this one composable. The recipe page
gaining a tooltip is a *consequence* of there being one mechanism, not a
second special case.

## Consequences

- Hovering the photo/title/padding no longer opens a tooltip; hovering the
  icon does, on both the browse tile and the recipe page.
- The keyboard path is unchanged and still e2e-pinned (focus the host, the
  bubble opens with the icon's accessible name).
- `useIconHoverTarget.ts` is new shared machinery. It is justified by DRY
  (one listener, not 120) and its invalidation is justified by SOLID, but it
  is the most complex thing in this area — if a future change makes it
  conditional, KISS should win and it should be deleted back to a per-icon
  `mouseenter`.
- e2e: `design-visual.spec.ts`'s tooltip case must be rewritten to hover the
  ICON's box and then assert a card hover elsewhere does NOT open it. The
  existing assertion that hovering `recipe-card-link` opens the bubble
  becomes the *negative* case.

## Decision log

- 2026-10-02 — chose the JS hit-test over the CSS row-anchor. Owner ruling:
  the trigger is the icon. CSS row-anchor lost because it is cheaper but
  answers a different question ("which row?" vs "which icon?"), and the
  owner asked for the icon.