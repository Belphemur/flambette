# ADR-0035: A design-token layer (DESIGN.md), categorical food hues, and a wider desktop

**Status:** Accepted (2026-10-01)
**Refines:** the "Icons (ADR-0029)" convention in `AGENTS.md` (categorical
hues on the icon stack) and the layout note in ADR-0016 (tab fit is still
pinned; only the surrounding container changed).

## Context

The app grew one screen at a time and the visual identity grew with it,
which left three problems that no single component owned.

**1. The palette was implicit.** `src/style.css` carried exactly one
colour decision — an orange `--color-primary` — and everything else was
ad-hoc Tailwind (`stone-*`, `rose-500`, `amber-300`, `text-primary-dark`).
There was no file that said what the app looks like, so "make it warmer",
"is this contrast OK in dark mode?" and "which colour is the sodium icon?"
were all open questions answered per-PR. Worse, the one brand colour was
an AA failure: `oklch(0.705 0.17 47.6)` is `#f27930`, and every
`bg-primary text-white` button in the app — the add-to-plan CTA, the
auto-plan confirm, the cooking next/finish buttons — measured **2.8:1**.

**2. Information had no colour.** A recipe card showed time and calories in
the same grey, and the recipe's ingredient *type* (the catalog publishes
exactly three: `meat`, `fish`, `vegetarian`) was invisible. Protein and
diet filter chips carried food icons that were all the same grey, so the
chips told you what they filtered and nothing about what they were.

**3. Desktop was an afterthought.** The shell was `max-w-2xl` (672px)
everywhere, because the app was designed phone-first and the desktop
browser was treated as "a big phone". At 1400px a 672px ribbon sat in a
sea of stone: the recipe grid stayed 2-3 columns, and the recipe detail
was one long single column. Nobody asked for that look; it was just what
fell out of never revisiting the container.

Meanwhile one hover affordance already existed in the codebase — the
`@media (hover: hover)` clickable-cursor rule (ADR-0016) — and proved the
pattern this app needs on touch: a pointer affordance is gated behind the
media query that actually describes the device.

## Decision

### 1. `DESIGN.md` is the single source of truth

A `DESIGN.md` at the repo root in Google's `design.md` format: YAML
front-matter tokens (`colors`, `typography`, `rounded`, `spacing`,
`components`) plus prose `Overview / Colors / Typography / Layout /
Elevation & Depth / Shapes / Components / Do's and Don'ts`. It lints
clean with `npx -y @google/design.md lint DESIGN.md` (0 errors, 0
warnings), including its WCAG contrast findings.

`src/style.css`'s `@theme` block is the **compilation** of those tokens
into Tailwind utilities — every colour value is transcribed from the
front-matter, with a comment giving the mapping. Components consume
`bg-brand`, `text-hue-fish`, `max-w-app`, … and **never** a raw hex. Two
tests hold the mirror in place (`src/lib/palette.test.ts`): a token
declared in one file and not the other fails the suite.

The neutral ramp is not duplicated: DESIGN.md's stone tokens map 1:1 onto
Tailwind's stock `stone-*` scale, and the mapping is written out as a
comment in `style.css`.

### 2. The brand orange is retired for the verified tomato

`--color-primary` / `--color-primary-dark` are **gone**. Every former
usage (buttons, chips, the active nav tab, focus rings, checkboxes, the
search border) now wears the new primary token:

| DESIGN.md token | CSS variable (`@theme`) | Role |
| --- | --- | --- |
| `primary` | `--color-brand` (`#b3381f`) | the one action colour: buttons, active tab, selection, focus |
| `primary-strong` | `--color-brand-strong` (`#8e2c17`) | accessible primary TEXT on light surfaces |
| `primary-soft` | `--color-brand-soft` (`#f08a6a`) | primary on the dark surface |
| `primary-tint` | `--color-brand-tint` (`#fbeae5`) | tinted chips/badges |
| `on-primary` | `--color-on-brand` (`#ffffff`) | text on a primary fill |

This is a deliberate, documented exception to "accents, not a re-theme":
the stone foundation is untouched, and only the single accent hue moved —
from an orange that failed contrast to the tomato that passes at 6.0:1.

### 3. Categorical hues for ingredient TYPE, semantic hues for NUTRITION

`src/lib/palette.ts` is the typed role → token map, and `HueIcon.vue`
renders the icon for a role in that role's colour. Five roles, and the
split between them is the point:

| Role | Kind | Token (`@theme`) | Light | Dark (stone-900) | Where it shows |
| --- | --- | --- | --- | --- | --- |
| `meat` | categorical | `--color-hue-meat` / `-soft` | `#b3381f` (5.7:1) | `#f08a6a` (7.1:1) | recipe card band, recipe detail header, protein + diet chips |
| `fish` | categorical | `--color-hue-fish` / `-soft` | `#0e7490` (5.1:1) | `#5cc0d8` (8.3:1) | same |
| `vegan` | categorical | `--color-hue-vegan` / `-soft` | `#3f7a33` (5.0:1) | `#7fc97a` (8.8:1) | same |
| `energy` | semantic | `--color-nutrition-energy` / `-soft` | `#c2410c` (5.0:1) | `#fbbf6e` (10.6:1) | the flame beside calories (card, detail) |
| `sodium` | semantic | `--color-nutrition-sodium` / `-soft` | `#4f46e5` (6.0:1) | `#a5b4fc` (8.8:1) | the droplet beside sodium (card band, detail) |

Rules that the code holds to:

- **A hue is an icon's identity, never its state.** A selected filter chip
  is still its own food hue in the idle state; selection itself is always
  the primary token, and a selected chip switches its icon to the chip's
  text colour (a `hue-meat` icon on a `primary` fill would be invisible).
- **Categorical and semantic families never mix.** A calorie icon may
  never wear the fish teal; that is the whole reason the semantic hues
  live in their own names.
- **No type, no icon.** `ingredientRole()` maps the catalog's three
  category names exactly and returns `null` for anything else — an
  unrecognised category renders no icon rather than a wrong hue.
- Decorative icons stay `aria-hidden` and are always beside a text label
  or an `aria-label` (ADR-0029); colour is never the only signal.

### 4. Fluid desktop width, capped at 1100px

`--container-app: 1100px` replaces `max-w-2xl` on the app shell, the
header, the bottom nav, ShopView and the Plan-tab sheets. It is **fluid**,
not fixed: at 1400px the content fills 1100px of centred window; on a
tablet it is simply the window.

The recipe grid answers the freed width: `grid-cols-2` (phone) →
`sm:grid-cols-3` → `lg:grid-cols-4` → `xl:grid-cols-5`.

**The recipe card gains a desktop-only metadata band.** The phone row
(energy + time) is untouched below `lg`; from `lg` the card shows one
horizontal band — ingredient TYPE, energy, time, sodium — and the wider
card carries a proportionally larger photo. Mobile padding, tap targets
and the `data-test="recipe-card"` hooks are unchanged.

**Recipe detail goes two-column at `lg`**: the ingredient list sits beside
the instructions instead of one 1100px ribbon.

**Cooking keeps its narrow measure** (`--container-reading`, 672px — the
old `max-w-2xl`, now named). Cooking is immersive and hands-busy: a step
read at arm's length wants a measure, not a page, and widening it would
make the immersive mode look like a browser tab. This is the one view
that deliberately does NOT follow the app container.

### 5. Nav icon hover: a 2px lift and an accent tint, on pointers only

Inside the **existing** `@media (hover: hover)` block in `src/style.css`,
the bottom-nav icon gets `translateY(-2px)` plus a tint to the primary
token over `150ms ease` (the dark surface tints to `primary-soft`). Under
`prefers-reduced-motion: reduce` the transform is dropped and the tint
stays — the lift is the motion, the tint is not.

The same reasoning as the existing cursor rule, and the same discipline:
the animation cannot be left stuck under a finger on touch, and **no hit
area, label or padding is touched** — ADR-0016's 82px/tab Pixel 7 fit is
still e2e-pinned.

## Consequences

- `DESIGN.md` is now the file to read before proposing any visual change,
  and it is linted, not aspirational. The palette contract is tested.
- Any new colour must be added to DESIGN.md, mirrored into `@theme`, and
  verified on BOTH surfaces before it is used; the unit test fails if the
  mirror drifts.
- Contrast is no longer a per-PR judgement call: the DESIGN.md lint and the
  declared component pairings surface it, and the legacy AA failure of the
  brand orange is gone rather than documented.
- Desktop gets a real presentation (5-column grid, metadata bands,
  two-column detail) without a single mobile pixel moving — every desktop
  affordance is `lg:`/`xl:`-gated.
- The colour migration touched ~50 call sites across 10 components. It is
  mechanical (a token rename), verified by the full suite, and it is the
  one part of this change that is not purely additive.

## Alternatives considered

- **Keep the orange, add hues around it.** Rejected: it leaves an
  AA-failing primary in place, and the app would carry two accent hues
  (orange + tomato) fighting each other.
- **Widen to a fixed 1100px.** Rejected: a fixed width wastes tablet and
  ultrawide windows; fluid-to-cap is the same amount of CSS and looks
  intentional everywhere.
- **Two-pane desktop layout.** Rejected as too much product change for a
  visual-identity PR; the wider single column plus a two-column recipe
  detail delivers the "looks good on desktop" goal without restructuring
  navigation.
- **Ship the hover animation everywhere.** Rejected: a touch device that
  keeps `:hover` sticky after a tap is exactly the bug the existing
  `@media (hover: hover)` cursor rule was written to avoid.
- **Colour the whole card background per type.** Rejected: it fights the
  photography and the stone foundation; a 14px icon plus a label carries
  the same information.