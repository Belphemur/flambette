---
version: alpha
name: Mealime Kitchen
description: >
  Warm & appetizing visual identity for the Mealime Planner SPA: a stone
  neutral foundation with food-site accent energy — tomato, herb, ocean and
  mushroom warmth — applied as categorical and semantic colour on an
  offline-first, mobile-first planner.
colors:
  # Primary — tomato. Actions, the active nav tab, focus rings, selection.
  primary: "#B3381F"
  primary-strong: "#8E2C17"
  primary-soft: "#F08A6A"
  primary-tint: "#FBEAE5"
  on-primary: "#FFFFFF"
  # Neutral foundation (stone) — the app's surfaces, text and dividers.
  surface: "#FAFAF9"
  surface-raised: "#FFFFFF"
  surface-sunken: "#F5F5F4"
  border: "#E7E5E4"
  border-strong: "#D6D3D1"
  text: "#292524"
  text-muted: "#57534E"
  text-subtle: "#78716C"
  # Dark-mode counterparts of the same ramp.
  surface-dark: "#0C0A09"
  surface-dark-raised: "#1C1917"
  surface-dark-sunken: "#292524"
  border-dark: "#44403C"
  text-dark: "#FAFAF9"
  text-dark-muted: "#A8A29E"
  # Categorical ingredient-type hues (light + the -soft dark-mode variant).
  hue-meat: "#B3381F"
  hue-meat-soft: "#F08A6A"
  hue-fish: "#0E7490"
  hue-fish-soft: "#5CC0D8"
  hue-vegan: "#3F7A33"
  hue-vegan-soft: "#7FC97A"
  # Semantic nutrition hues.
  nutrition-energy: "#C2410C"
  nutrition-energy-soft: "#FBBF6E"
  nutrition-sodium: "#4F46E5"
  nutrition-sodium-soft: "#A5B4FC"
  # Status.
  warning: "#9A3412"
  danger: "#B91C1C"
  favourite: "#E11D48"
  favourite-soft: "#FB7185"
typography:
  headline-lg:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: -0.01em
  headline-md:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: -0.01em
  title:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.4
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
  body-sm:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.45
  label-md:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.3
  label-caps:
    fontFamily: Inter
    fontSize: 10px
    fontWeight: 700
    lineHeight: 1
    letterSpacing: 0.08em
rounded:
  sm: 6px
  md: 8px
  lg: 12px
  xl: 16px
  full: 9999px
spacing:
  base: 4px
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  2xl: 32px
  container: 1100px
  reading: 672px
  gutter: 12px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.md}"
    padding: 12px
  button-ghost:
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: 12px
  chip-selected:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.full}"
    padding: 12px
  chip-idle:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text}"
    rounded: "{rounded.full}"
    padding: 12px
  chip-idle-dark:
    backgroundColor: "{colors.surface-dark-raised}"
    textColor: "{colors.text-dark-muted}"
    rounded: "{rounded.full}"
    padding: 12px
  card:
    backgroundColor: "{colors.surface-raised}"
    rounded: "{rounded.xl}"
  card-dark:
    backgroundColor: "{colors.surface-dark-raised}"
    rounded: "{rounded.xl}"
  card-sunken:
    backgroundColor: "{colors.surface-sunken}"
    rounded: "{rounded.md}"
  card-sunken-dark:
    backgroundColor: "{colors.surface-dark-sunken}"
    rounded: "{rounded.md}"
  card-border:
    backgroundColor: "{colors.border}"
    height: 1px
  card-border-dark:
    backgroundColor: "{colors.border-dark}"
    height: 1px
  divider:
    backgroundColor: "{colors.border-strong}"
    height: 1px
  divider-dark:
    backgroundColor: "{colors.border-dark}"
    height: 1px
  app-surface:
    backgroundColor: "{colors.surface}"
  app-surface-dark:
    backgroundColor: "{colors.surface-dark}"
  favourite-heart-active:
    backgroundColor: "{colors.text}"
    textColor: "{colors.favourite-soft}"
    size: 36px
  favourite-heart-idle:
    backgroundColor: "{colors.text}"
    textColor: "{colors.on-primary}"
    size: 36px
  badge-warning:
    backgroundColor: "{colors.primary-tint}"
    textColor: "{colors.warning}"
    rounded: "{rounded.sm}"
    padding: 6px
  badge-danger:
    backgroundColor: "{colors.primary-tint}"
    textColor: "{colors.danger}"
    rounded: "{rounded.sm}"
    padding: 6px
  badge-favourite:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.favourite}"
    rounded: "{rounded.sm}"
    padding: 6px
  promo-badge-pro:
    backgroundColor: "{colors.text}"
    textColor: "{colors.nutrition-energy-soft}"
    rounded: "{rounded.sm}"
    padding: 6px
  recipe-card:
    backgroundColor: "{colors.surface-dark-raised}"
    textColor: "{colors.text-dark}"
    rounded: "{rounded.lg}"
  recipe-card-dark:
    backgroundColor: "{colors.surface-dark-raised}"
    textColor: "{colors.text-dark}"
    rounded: "{rounded.xl}"
  recipe-card-title:
    textColor: "{colors.text}"
    typography: "{typography.title}"
  recipe-card-meta:
    textColor: "{colors.text-muted}"
    typography: "{typography.label-md}"
  recipe-card-meta-dark:
    textColor: "{colors.text-dark-muted}"
    typography: "{typography.label-md}"
  recipe-card-meta-band:
    backgroundColor: "{colors.surface-sunken}"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.md}"
    typography: "{typography.label-md}"
  recipe-card-meta-band-dark:
    backgroundColor: "{colors.surface-dark-sunken}"
    textColor: "{colors.text-dark-muted}"
    rounded: "{rounded.md}"
    typography: "{typography.label-md}"
  icon-hue-meat:
    textColor: "{colors.hue-meat}"
    size: 16px
  icon-hue-meat-dark:
    textColor: "{colors.hue-meat-soft}"
    size: 16px
  icon-hue-fish:
    textColor: "{colors.hue-fish}"
    size: 16px
  icon-hue-fish-dark:
    textColor: "{colors.hue-fish-soft}"
    size: 16px
  icon-hue-vegan:
    textColor: "{colors.hue-vegan}"
    size: 16px
  icon-hue-vegan-dark:
    textColor: "{colors.hue-vegan-soft}"
    size: 16px
  icon-nutrition-energy:
    textColor: "{colors.nutrition-energy}"
    size: 16px
  icon-nutrition-energy-dark:
    textColor: "{colors.nutrition-energy-soft}"
    size: 16px
  icon-nutrition-sodium:
    textColor: "{colors.nutrition-sodium}"
    size: 16px
  icon-nutrition-sodium-dark:
    textColor: "{colors.nutrition-sodium-soft}"
    size: 16px
  nav-bar:
    backgroundColor: "{colors.surface-raised}"
  nav-bar-dark:
    backgroundColor: "{colors.surface-dark-raised}"
  nav-tab:
    textColor: "{colors.text-subtle}"
    typography: "{typography.label-md}"
    height: 56px
  nav-tab-active:
    textColor: "{colors.primary-strong}"
    typography: "{typography.label-md}"
  nav-tab-icon-hover:
    textColor: "{colors.primary}"
    height: 28px
  nav-tab-icon-hover-dark:
    textColor: "{colors.primary-soft}"
    height: 28px
---

# Mealime Planner — Design System

## Overview

Mealime Planner is an **offline-first kitchen planner**, and it should look
like one: warm, appetizing, and a little editorial — the energy of a good
food site, engineered down to something that survives a 412px phone and a
1400px desktop with the same bone structure.

The identity is **"warm & appetizing"**. The whole app is built on a
**stone neutral foundation** — warm greys, never blue-greys — because the
content is photography and text, and the chrome must never compete with a
food photo. Over that foundation sit **food-site accents**: a tomato red
that reads as ripe and hot, an herb green that reads as fresh, an ocean
teal that reads as fresh fish, and a saffron ember for energy. Colour is an
**accent layer, never a re-theme**: at most one accent hue is visible per
surface region, and the stone ramp does all the structural work.

**Who it is for.** A household planning the week from two phones and a
laptop; a cook standing at a counter with greasy hands; someone reading a
recipe at arm's length. **Emotional target:** "this app was made by someone
who cooks" — appetising, legible, fast, and never fussy.

**Vibrancy.** Restrained. The vibrancy lives in the **photo**, in the
**hue of a 16px icon**, and in a **2px hover lift** on the nav. Everything
else is quiet: stone surfaces, hairline borders, soft shadows. A planner is
a tool you use daily; novelty wears out in a week, appetite does not.

**Mobile first, desktop generous.** The phone layout is the reference: five
bottom tabs, 82px per tab, everything reachable with a thumb. Desktop is
not a stretched phone — it gets a **fluid container capped at 1100px** and
richer cards, while the immersive cooking view keeps its narrow reading
column because a step you are reading at arm's length wants a measure, not a
page.

## Colors

The palette is rooted in **warm stone neutrals** with a single evocative
accent family, plus a small set of **categorical** and **semantic** hues.
Every hue below is contrast-verified on BOTH the light surface
(`#FAFAF9`) and the dark surface (`#1C1917`) — 4.5:1 or better, so an
accent icon is never decoration that disappears.

- **Primary — Tomato (`#B3381F` / strong `#8E2C17` / soft `#F08A6A`):**
  the app's one action colour. Primary buttons, the active bottom-nav tab,
  focus rings, the selected quick-filter chip. The soft variant is the dark
  mode stand-in (7.1:1 on `#1C1917`); the strong variant is the accessible
  tomato for tomato text on light surfaces.
- **Neutral — Stone (`#FAFAF9` → `#292524`):** the foundation. Surfaces,
  dividers, body text, muted metadata. Warm greys, never blue-greys — the
  whole app should feel like a stone counter, not a dashboard.
- **Categorical — Herb (`#3F7A33`), Ocean (`#0E7490`), Tomato (`#B3381F`):**
  the ingredient-TYPE hues. They answer "what kind of food is this" at a
  glance on a recipe card and on the protein/diet filter chips. They are
  never used for state — a chip that is *selected* is brand, not herb.
- **Semantic — Saffron Ember (`#C2410C`) and Iris (`#4F46E5`):** the
  nutrition hues. Ember is energy (the flame, calories); iris is sodium (the
  droplet). They are deliberately NOT in the categorical family so a calorie
  icon can never be mistaken for an ingredient type.
- **Status:** amber for warnings, red for destructive, rose for the
  favourite heart (a household favourite is a preference, not an error).

**Legacy note — the brand orange is RETIRED.** Before this system the app
shipped a single brand orange (`#F27930`) as `--color-primary`. White text
on it measured **2.8:1** — below WCAG AA — so every `bg-primary text-white`
button in the app was quietly failing contrast. This system replaces it
with the verified tomato (`#B3381F`, 6.0:1) and every legacy `primary` /
`primary-dark` usage now wears the new token; the old variables are gone
from `src/style.css`. Do not reintroduce an orange-on-white pairing.

**Tokens are the law.** `DESIGN.md` is the single source of truth; every
token is mirrored into the Tailwind v4 `@theme` block in `src/style.css`,
and components consume `text-*` / `bg-*` utilities derived from those
variables. A raw hex literal in a component is a bug.

**Contrast.** Every token pairing declared above was checked with a WCAG
calculator against the surface it ships on: 6.0:1 for white on primary,
4.4–8.8:1 for the categorical and nutrition hues on `#FAFAF9`, and
6.0–10.6:1 for their `-soft` counterparts on `#1C1917`. Metadata text uses
`text-muted` (`#57534E`, 7.0:1 on the sunken band) rather than
`text-subtle`, which is reserved for nav labels on a raised surface.

## Typography

Inter, and only Inter. The type system is small because the app is dense
with metadata: **two weights only (400 / 600-700)**, a tight tracking
scale, and short line-heights. Numerals (calories, minutes, sodium) are
`label-md` — small, medium weight, tabular where possible.

- **Headlines:** 24px/700 (recipe title), 18px/700 (app header), tracking
  -0.01em. Tight enough to feel editorial, never compressed.
- **Body:** 14px/400 at 1.5 — the reading size everywhere, including
  recipe steps.
- **Labels:** 12px/500 for metadata rows (the desktop recipe-card meta
  band), 10px/700 uppercase +0.08em for the PRO badge.

## Layout

**Fluid container, 1100px cap.** One shell container token
(`--container-app`) drives the app frame, the header and the bottom nav.
It is fluid, not fixed: on a 1400px window it fills 1100px of centred
content; on a tablet it is simply the window. A 672px **reading** token
stays reserved for the immersive cooking view, where a long measure would be
tiring to read.

**Mobile is the reference.** 2-column recipe grid, 3-up from `sm`, 4-up at
`lg`, 5-up at `xl` (the wider the card, the more of the desktop meta band it
can carry). Controls sit on a 2-column grid on phones so nothing is orphaned
on its own line.

**Spacing** is a 4px scale (`xs` 4 / `sm` 8 / `md` 12 / `lg` 16 / `xl` 24 /
`2xl` 32). Cards are internally padded at 12px on mobile.

## Elevation & Depth

Depth is **tonal, not shadowed**. Cards are one step off the page surface
(`#FFFFFF` on `#FAFAF9`; `#1C1917` on `#0C0A09`) with a hairline ring, plus
a soft `shadow-sm` that only grows to `shadow-md` when a pointer is
hovering. Scrims (`bg-stone-900/70`) sit under overlaid controls (favourite
heart, PRO badge) so they read on any photo brightness.

## Shapes

**Softly rounded, consistently so**: 8px controls, 12px chips' inner
elements, 16px cards, fully-round chips, hearts and scrim discs. Never mix
radii inside one component; never introduce a sharp 2px corner.

## Components

- **Recipe card:** photo on top (4:3), then title, then a metadata row.
  The card itself carries no light fill (the photo is the surface) and is
  `rounded-lg` (12px); the dark surface is `surface-dark-raised`. From
  `lg` the card gains a **horizontal metadata band** across the bottom —
  ingredient-TYPE icon, energy, time and sodium all on one row — and a
  larger image. Mobile layout, padding and tap targets are never changed
  to serve desktop.
- **Bottom nav:** five tabs, icon above a 12px label, `min-height: 56px`
  per tab (82px wide at Pixel 7 — measured, e2e-pinned, ADR-0016). The
  active tab is brand-strong; idle tabs are `text-subtle`.
- **Nav icon hover (desktop only):** on a hover-capable pointer, the icon
  rises 2px and tints to brand over 150ms ease. Inside
  `@media (hover: hover)` only, and the transform is dropped under
  `prefers-reduced-motion` (the tint stays — it carries no motion).
- **Quick-filter chips:** 36px tall, full-round, brand fill when selected.
  A food icon wears its categorical hue in the IDLE state; when the chip
  is SELECTED it takes the chip's text colour instead, because a hue-600
  icon on a `primary` fill is invisible. Selection is still signalled by
  the fill, not by the icon's hue.
- **Iconography (ADR-0029):** Lucide, bundled, no glyph characters. A
  decorative icon is `aria-hidden`; an icon that carries state is
  queryable (`aria-label` / `aria-expanded`).

## Do's and Don'ts

- Do reach for exactly ONE accent hue per surface region — a card shows one
  categorical icon, a chip row shows one family.
- Do use the categorical hues for ingredient TYPE and the semantic hues for
  nutrition; never swap them, never let a calorie icon wear the fish teal.
- Do keep every accent at 4.5:1 or better on the surface it sits on, in
  both light and dark mode. Check the dark variant before shipping.
- Do keep tap targets and mobile padding exactly as they are; desktop
  richness is added with `lg:`/`xl:` only.
- Do gate every hover affordance behind `@media (hover: hover)` and honour
  `prefers-reduced-motion`.
- Don't re-theme the stone foundation — the neutrals are what makes the
  photography and the accents sing.
- Don't introduce a second font, a new font weight, or raw hex in a
  component.
- Don't use colour as the only signal: every coloured icon keeps its text
  label or its `aria-label`.
- Don't use brand tomato for "selected" state and a categorical hue for the
  same thing in another surface — selection is always brand.