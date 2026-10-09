---
version: warm-culinary-paper-v2
name: Flambette — Warm Culinary Paper
description: 'An editorial culinary notebook: cream paper stock, espresso ink, ripe-tomato intent.
  Cards are keylined index cards resting on a counter, never floating on shadows;
  type is Plus Jakarta Sans with JetBrains Mono as the data voice.'
colors:
  primary: "#B3381F"
  primary-strong: "#8E2C17"
  primary-soft: "#F08A6A"
  primary-tint: "#FBEAE5"
  primary-tint-dark: "#44241D"
  on-primary: "#FFFFFF"
  surface: "#FBF8F2"
  surface-raised: "#F4EFE6"
  surface-sunken: "#EDE5D8"
  border: "#E3D8C8"
  border-strong: "#947E64"
  text: "#1C1C18"
  text-muted: "#59413C"
  surface-dark: "#171310"
  surface-dark-raised: "#241C18"
  surface-dark-sunken: "#32261F"
  border-dark: "#564438"
  border-dark-strong: "#A28E80"
  text-dark: "#FFF8F0"
  text-dark-muted: "#C7B5A6"
  hue-meat: "#B3381F"
  hue-meat-soft: "#F08A6A"
  hue-fish: "#0E7490"
  hue-fish-soft: "#5CC0D8"
  hue-vegetarian: "#137A38"
  hue-vegetarian-soft: "#86EFAC"
  hue-vegan: "#047857"
  hue-vegan-soft: "#6EE7B7"
  meal-breakfast: "#946200"
  meal-breakfast-soft: "#FBBF24"
  meal-dessert: "#A81E6B"
  meal-dessert-soft: "#F472B6"
  meal-snack: "#8C5F33"
  meal-snack-soft: "#EBC49A"
  meal-lunch: "#3730A3"
  meal-lunch-soft: "#A5B4FC"
  meal-dinner: "#571814"
  meal-dinner-soft: "#FDBCBC"
  nutrition-energy: "#B83A0A"
  nutrition-energy-soft: "#FBBF6E"
  nutrition-sodium: "#4F46E5"
  nutrition-sodium-soft: "#A5B4FC"
  nutrition-protein: "#7C4DBE"
  nutrition-protein-soft: "#C4A8F5"
  nutrition-carbs: "#0E7490"
  nutrition-carbs-soft: "#5CC0D8"
  nutrition-fat: "#7A5F0C"
  nutrition-fat-soft: "#E8C86A"
  warning: "#9A3412"
  warning-soft: "#FDBA74"
  saffron: "#D97706"
  saffron-soft: "#FCD34D"
  espresso: "#2B1E1A"
  espresso-dark: "#1E1512"
  popover: "#FFFFFF"
  popover-dark: "#2C231E"
  chrome-muted: "#C7B5A6"
  chrome-backplate: "#FBEAE5"
  chrome-backplate-text: "#8E2C17"
  chrome-border: "#A28E80"
  chrome-accent: "#F08A6A"
  success: "#116149"
  success-soft: "#34D399"
  on-success: "#FFFFFF"
  danger: "#B91C1C"
  danger-soft: "#FCA5A5"
  favourite: "#C9183C"
  favourite-soft: "#FB7185"
  household: "#86198F"
  household-soft: "#E879F9"
typography:
  display-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 48px
    fontWeight: 700
    lineHeight: 56px
  headline-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 36px
    fontWeight: 700
    lineHeight: 44px
  headline-lg-mobile:
    fontFamily: Plus Jakarta Sans
    fontSize: 28px
    fontWeight: 700
    lineHeight: 36px
  headline-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 24px
    fontWeight: 700
    lineHeight: 32px
  headline-sm:
    fontFamily: Plus Jakarta Sans
    fontSize: 20px
    fontWeight: 700
    lineHeight: 28px
  title:
    fontFamily: Plus Jakarta Sans
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.4
  body-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 18px
    fontWeight: 400
    lineHeight: 28px
  body-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.55
  body-sm:
    fontFamily: Plus Jakarta Sans
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
  label-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.4
  label-sm:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: 0.04em
  mono-data:
    fontFamily: JetBrains Mono
    fontSize: 13px
    fontWeight: 500
    lineHeight: 18px
    letterSpacing: 0
  cooking-step:
    fontFamily: Plus Jakarta Sans
    fontSize: 20px
    fontWeight: 500
    lineHeight: 1.6
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
  gutter-mobile: 16px
  gutter-desktop: 24px
  touch-target: 44px
components:
  user-recipe-badge:
    textColor: "{colors.household}"
  user-recipe-badge-dark:
    textColor: "{colors.household-soft}"
  app-surface:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
  app-surface-dark:
    backgroundColor: "{colors.surface-dark}"
    textColor: "{colors.text-dark}"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    height: 48px
    rounded: "{rounded.lg}"
  button-primary-hover:
    backgroundColor: "{colors.primary-strong}"
    textColor: "{colors.on-primary}"
  button-primary-dark:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    height: 48px
    rounded: "{rounded.lg}"
  button-secondary:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.primary-strong}"
    height: 44px
    rounded: "{rounded.lg}"
  button-secondary-dark:
    backgroundColor: "{colors.surface-dark-raised}"
    textColor: "{colors.primary-soft}"
    height: 44px
    rounded: "{rounded.lg}"
  chip-idle:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text}"
    height: 44px
    rounded: "{rounded.full}"
  chip-idle-dark:
    backgroundColor: "{colors.surface-dark-raised}"
    textColor: "{colors.text-dark}"
    height: 44px
    rounded: "{rounded.full}"
  chip-selected:
    backgroundColor: "{colors.primary-tint}"
    textColor: "{colors.primary-strong}"
    height: 44px
    rounded: "{rounded.full}"
  chip-selected-dark:
    backgroundColor: "{colors.primary-tint-dark}"
    textColor: "{colors.primary-soft}"
    height: 44px
    rounded: "{rounded.full}"
  recipe-card:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text}"
    rounded: "{rounded.xl}"
  recipe-card-dark:
    backgroundColor: "{colors.surface-dark-raised}"
    textColor: "{colors.text-dark}"
    rounded: "{rounded.xl}"
  recipe-card-meta:
    backgroundColor: "{colors.surface-sunken}"
    textColor: "{colors.text-muted}"
    typography: "{typography.label-md}"
  recipe-card-meta-dark:
    backgroundColor: "{colors.surface-dark-sunken}"
    textColor: "{colors.text-dark-muted}"
    typography: "{typography.label-md}"
  divider:
    backgroundColor: "{colors.border}"
    height: 1px
  divider-dark:
    backgroundColor: "{colors.border-dark}"
    height: 1px
  control-border:
    backgroundColor: "{colors.border-strong}"
    height: 1px
  control-border-dark:
    backgroundColor: "{colors.border-dark-strong}"
    height: 1px
  field:
    backgroundColor: "{colors.surface-sunken}"
    textColor: "{colors.text}"
    height: 44px
    rounded: "{rounded.lg}"
  field-dark:
    backgroundColor: "{colors.surface-dark-sunken}"
    textColor: "{colors.text-dark}"
    height: 44px
    rounded: "{rounded.lg}"
  nav-bar:
    backgroundColor: "{colors.espresso}"
    textColor: "{colors.chrome-muted}"
    height: 56px
  nav-bar-dark:
    backgroundColor: "{colors.espresso-dark}"
    textColor: "{colors.chrome-muted}"
    height: 56px
  nav-tab-active:
    backgroundColor: "{colors.chrome-backplate}"
    textColor: "{colors.chrome-backplate-text}"
  nav-tab-active-dark:
    backgroundColor: "{colors.chrome-backplate}"
    textColor: "{colors.chrome-backplate-text}"
  nav-tab-icon-hover:
    textColor: "{colors.chrome-accent}"
  nav-tab-icon-hover-dark:
    textColor: "{colors.chrome-accent}"
  nav-edge:
    backgroundColor: "{colors.chrome-border}"
    height: 1px
  nav-edge-dark:
    backgroundColor: "{colors.chrome-border}"
    height: 1px
  badge-warning:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.warning}"
  badge-warning-dark:
    backgroundColor: "{colors.surface-dark-raised}"
    textColor: "{colors.warning-soft}"
  live-room-dot:
    backgroundColor: "{colors.success}"
  live-room-dot-dark:
    backgroundColor: "{colors.success-soft}"
  avatar:
    size: 40px
    rounded: "{rounded.full}"
  avatar-sm:
    size: 28px
    rounded: "{rounded.full}"
  badge-danger:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.danger}"
  badge-danger-dark:
    backgroundColor: "{colors.surface-dark-raised}"
    textColor: "{colors.danger-soft}"
  favourite-filter:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.favourite}"
  favourite-filter-dark:
    backgroundColor: "{colors.surface-dark-raised}"
    textColor: "{colors.favourite-soft}"
  photo-control:
    backgroundColor: "{colors.espresso}"
    textColor: "{colors.on-primary}"
    size: 44px
    rounded: "{rounded.full}"
  photo-heart-active:
    backgroundColor: "{colors.espresso}"
    textColor: "{colors.favourite-soft}"
    size: 44px
    rounded: "{rounded.full}"
  popover:
    backgroundColor: "{colors.popover}"
    textColor: "{colors.text}"
    rounded: "{rounded.lg}"
  popover-dark:
    backgroundColor: "{colors.popover-dark}"
    textColor: "{colors.text-dark}"
    rounded: "{rounded.lg}"
  timer-chip:
    textColor: "{colors.saffron}"
  timer-chip-dark:
    textColor: "{colors.saffron-soft}"
  icon-hue-meat:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.hue-meat}"
    size: 18px
  icon-hue-meat-dark:
    backgroundColor: "{colors.surface-dark-raised}"
    textColor: "{colors.hue-meat-soft}"
    size: 18px
  icon-hue-fish:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.hue-fish}"
    size: 18px
  icon-hue-fish-dark:
    backgroundColor: "{colors.surface-dark-raised}"
    textColor: "{colors.hue-fish-soft}"
    size: 18px
  icon-hue-vegetarian:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.hue-vegetarian}"
    size: 18px
  icon-hue-vegetarian-dark:
    backgroundColor: "{colors.surface-dark-raised}"
    textColor: "{colors.hue-vegetarian-soft}"
    size: 18px
  icon-hue-vegan:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.hue-vegan}"
    size: 18px
  icon-hue-vegan-dark:
    backgroundColor: "{colors.surface-dark-raised}"
    textColor: "{colors.hue-vegan-soft}"
    size: 18px
  icon-meal-breakfast:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.meal-breakfast}"
    size: 18px
  icon-meal-breakfast-dark:
    backgroundColor: "{colors.surface-dark-raised}"
    textColor: "{colors.meal-breakfast-soft}"
    size: 18px
  icon-meal-dessert:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.meal-dessert}"
    size: 18px
  icon-meal-dessert-dark:
    backgroundColor: "{colors.surface-dark-raised}"
    textColor: "{colors.meal-dessert-soft}"
    size: 18px
  icon-meal-snack:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.meal-snack}"
    size: 18px
  icon-meal-snack-dark:
    backgroundColor: "{colors.surface-dark-raised}"
    textColor: "{colors.meal-snack-soft}"
    size: 18px
  icon-meal-lunch:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.meal-lunch}"
    size: 18px
  icon-meal-lunch-dark:
    backgroundColor: "{colors.surface-dark-raised}"
    textColor: "{colors.meal-lunch-soft}"
    size: 18px
  icon-meal-dinner:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.meal-dinner}"
    size: 18px
  icon-meal-dinner-dark:
    backgroundColor: "{colors.surface-dark-raised}"
    textColor: "{colors.meal-dinner-soft}"
    size: 18px
  icon-nutrition-energy:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.nutrition-energy}"
    size: 18px
  icon-nutrition-energy-dark:
    backgroundColor: "{colors.surface-dark-raised}"
    textColor: "{colors.nutrition-energy-soft}"
    size: 18px
  icon-nutrition-sodium:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.nutrition-sodium}"
    size: 18px
  icon-nutrition-sodium-dark:
    backgroundColor: "{colors.surface-dark-raised}"
    textColor: "{colors.nutrition-sodium-soft}"
    size: 18px
  donut-protein:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.nutrition-protein}"
  donut-protein-dark:
    backgroundColor: "{colors.surface-dark-raised}"
    textColor: "{colors.nutrition-protein-soft}"
  donut-carbs:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.nutrition-carbs}"
  donut-carbs-dark:
    backgroundColor: "{colors.surface-dark-raised}"
    textColor: "{colors.nutrition-carbs-soft}"
  donut-fat:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.nutrition-fat}"
  donut-fat-dark:
    backgroundColor: "{colors.surface-dark-raised}"
    textColor: "{colors.nutrition-fat-soft}"
---

# Mealime Planner — Design System

## Overview

**Direction: a warm, photo-led kitchen companion, not a grey utility with coloured icons.**
**Product promise: choose meals together, buy what you need, and cook without
friction.** This is a household meal-planning tool with a recipe library, not a
recipe-content feed or a calorie-tracking app. Its distinctive value is the path
from appetising choices to a practical, waste-aware plan and one usable grocery list.

The entry surface is **Explore** (find food). Plan and grocery are **Operate**
(assemble meals, adjust servings, shop together); cooking is **Command / Inspect**
(one step, ingredients and timers at arm's length). Settings is **Configure**.
Compose for the job of each surface, not one repeated card template. No marketing
hero, weekday calendar, engagement streaks, invented savings dashboard or AI branding.

### Product basis and precedence

- [PRD](docs/PRD.md): the product brief this document serves — personas,
  pillars, the five surfaces and the roadmap; scope changes keep it current.
- [README](README.md), Features: browse → plan → derived grocery → shopping →
  cooking, local catalog/images, adjustable servings, backup and household sync.
- [ADR-0024](docs/design/ADR-0024-auto-plan-pack-builder.md): the differentiator is
  assembling a useful set of meals with fewer extra packages, not merely showing
  recipes. Plans are explicitly unscheduled lists, never day-assigned calendars.
- [ADR-0033](docs/design/ADR-0033-auto-plan-regenerate-seed.md): Auto-Plan is
  deterministic for its inputs including generation; Regenerate offers another
  pack. Preserve preview, add/replace choice, confirmation and undo.
- [ADR-0032](docs/design/ADR-0032-cooked-history-shared-by-default.md): household
  history sharing is on by default with an explicit send-side opt-out. Do not copy
  the README's stale personal-by-default wording into new UI.
- [ADR-0034](docs/design/ADR-0034-cook-anytime.md): any recipe can be cooked now;
  cooking need not wait for planning. History retains plan identity, creation date
  and individual cook events, including ad-hoc single-recipe plans.
- [AGENTS](AGENTS.md): local assets, bundled Lucide, shared filters, derived
  grocery, existing state/room rules and five labelled navigation tabs.

Newer accepted behaviour ADRs and tested implementation outrank old README prose;
this visual specification does not authorise business-logic changes. No new accounts,
onboarding requirement, external service, runtime AI or mandatory room connection.
Household sharing improves the workflow but offline/local use remains complete.

This revision replaces the previous accent-only direction. The owner permits a
complete visual rethink. Typography, surfaces, layout and component hierarchy can
change on desktop AND mobile. Preserve behaviour, routes, data and accessibility,
not accidental old CSS. Use the existing Vue/Tailwind/Lucide stack; no new runtime
library, external font request, invented dietary classification or storage migration.

**Character:** the v2 direction is **“Warm Culinary Paper”** — an editorial culinary
notebook, not software ([EXPERIENCE.md](docs/EXPERIENCE.md), owner ruling 2026-10-09).
Cream paper stock (`#FBF8F2` page), warm paper cards, espresso ink, ripe-tomato intent.
Cards are index cards resting on a counter — keylined, never floating on shadows.
Photography is the appetite; type is the voice; tomato is spent only where the user
commits. Roasted espresso is the SECONDARY chrome (bottom nav, photo-scrim discs) in
BOTH themes — dark chrome in light mode, as the reviewed renders show. Avoid gradients,
translucent control surfaces, fake metrics, ornamental icons and rainbow panels.

**v2 token adoption:** [ADR-0066](docs/design/ADR-0066-typography-self-hosted-fonts.md)
(self-hosted Plus Jakarta Sans + JetBrains Mono),
[ADR-0067](docs/design/ADR-0067-colour-warm-culinary-paper.md) (colour values, token
names kept), [ADR-0068](docs/design/ADR-0068-elevation-tonal-paper-layering.md)
(tonal paper layering + scoped modal blur),
[ADR-0069](docs/design/ADR-0069-chip-treatment-always-tinted.md) (always-tinted
chips), [ADR-0070](docs/design/ADR-0070-search-into-header.md) (search into the
header). Token NAMES are unchanged — components keep consuming `bg-surface-raised`,
`text-hue-fish`… — only the VALUES re-pointed.

**Authority:** the YAML defines token values; the sections below define their use.
`src/style.css` must mirror the tokens, not redefine them. `DESIGN.tokens.json` is
a generated DTCG export, never a second source. [ADR-0036](docs/design/ADR-0036-kitchen-companion-redesign.md)
supersedes ADR-0035's accent-only, frozen-mobile and five-column decisions. This
document specifies the target; it is NOT a claim that existing components conform.

## Colors

### Roles and theme pairing

| Role | Light | Dark | Intended use |
| --- | --- | --- | --- |
| Page | `surface` paper-base `#FBF8F2` | `surface-dark` espresso | Background around content |
| Card | `surface-raised` paper `#F4EFE6` | `surface-dark-raised` warm charcoal | A clear raised surface, never transparent by accident |
| Metadata / wells / fields | `surface-sunken` paper-elevated `#EDE5D8` | `surface-dark-sunken` cocoa | Secondary bands and the sunken field fill, never primary actions |
| Main text | `text` | `text-dark` | Headlines, paragraphs, values |
| Secondary text | `text-muted` | `text-dark-muted` | Metadata, hints, idle navigation; still readable |
| Main action | `primary` with `on-primary` | SAME pairing | Filled tomato buttons, including Start cooking |
| Action hover / pressed | `primary-strong` with `on-primary` | SAME pairing | A darker tomato, not an opacity fade |
| Action text / selection | `primary-strong` on `primary-tint` | `primary-soft` on `primary-tint-dark` | Secondary actions, selected chips, active nav |
| Control boundary | `border-strong` `#947E64` | `border-dark-strong` | Inputs and controls whose outlines carry meaning |
| Decorative divider | `border` | `border-dark` | Grouping only, never the sole affordance |
| Chrome (bottom nav, photo discs) | `espresso` `#2B1E1A` | `espresso-dark` `#1E1512` | The SECONDARY surface — literal dark chrome in BOTH themes (ADR-0067) |
| Chrome foreground | `chrome-*` | SAME pairing | Labels, backplate and accent ON the espresso chrome; never flips (the chrome is dark in both themes) |
| Popover | `popover` white | `popover-dark` `#2C231E` | Elevation level 2 only — popovers, dropdowns, sticky bars + the ONE warm shadow |
| Timers / heat / tips | `saffron` `#D97706` | `saffron-soft` `#FCD34D` | A non-food family; never a diet or category cue |
| Modal scrim | espresso @ 45% + 6px blur | espresso @ 45% + 6px blur | Modals/sheets ONLY (ADR-0068); page backgrounds never blur |

The dark `primary-soft` is for text, icon tints and keylines, NOT a pale button
fill with white text. In dark mode add a `primary-soft` keyline to the filled
primary action: white text on tomato is readable, but the tomato fill alone is
not a sufficiently clear boundary against every dark panel. Secondary buttons
use a real surface and a visible outline in both themes.

### Food and nutrition identities

| Meaning | Glyph (Lucide) | Light / dark | Where it belongs |
| --- | --- | --- | --- |
| Meat | Beef | `hue-meat` / `hue-meat-soft` | Catalog category and matching filters |
| Fish | Fish | `hue-fish` / `hue-fish-soft` | Catalog category and matching filters |
| Vegetarian | Salad | `hue-vegetarian` / `hue-vegetarian-soft` | Green salad bowl; NEVER the vegan glyph |
| Vegan | Sprout | `hue-vegan` / `hue-vegan-soft` | Distinct mint-green sprout in the existing vegan diet filter |
| Energy / calories | Flame | `nutrition-energy` / `nutrition-energy-soft` | Card metadata and recipe nutrition |
| Sodium | Droplet | `nutrition-sodium` / `nutrition-sodium-soft` | Recipe nutrition only; NOT browse cards |
| Protein (calories) | — (no glyph) | `nutrition-protein` / `nutrition-protein-soft` | Nutrition-facts macro donut arc + legend only |
| Carbohydrates (calories) | — (no glyph) | `nutrition-carbs` / `nutrition-carbs-soft` | Nutrition-facts macro donut arc + legend only |
| Fat (calories) | — (no glyph) | `nutrition-fat` / `nutrition-fat-soft` | Nutrition-facts macro donut arc + legend only |

The three macro tokens are ARC/LEGEND identities, not food identities: a
recipe is never "the violet one", so they appear nowhere outside the nutrition
facts modal. They carry NO glyph and NO `IconRole` — the legend word beside the
arc is the name, exactly as a labelled control's word is.

Vegetarian is fresh green, not the old yellow/olive. Vegan is a separate green
and a different silhouette. Glyph + accessible name carry the distinction even
when colour is indistinguishable. Do not use an arbitrary hue-angle threshold as
proof of accessibility. ONE role-to-glyph-and-token mapping drives all call sites;
no hand-written competing glyphs in filter chips, cards, details or plan previews.
An exclusion filter keeps its explicit wording/strike treatment: a red meat icon
alone must not mean "no meat". Do not claim a recipe is vegan from a vegetarian
category; the published categories and existing diet heuristics stay unchanged.

**Measured palette, not blanket accessibility claims (v2 values).** WCAG sRGB
calculations for the values above give white on tomato **6.00:1** (hover **8.32:1**).
On the new paper the core text pairs are: `text` on page **16.12:1** / card
**14.92:1** / well **13.67:1**; `text-muted` **8.82 / 8.16 / 7.48:1**;
`primary-strong` as text **7.85 / 7.27 / 6.66:1**. Across all four allowed light
backgrounds (page, card, band, selected tint), the six food/nutrition foregrounds
are at least **4.29:1** (`hue-fish` on the sunken well; all ≥ 4.19 on the band,
≥ 4.5 on page and card); their dark counterparts are at least **5.64:1** across the
four dark equivalents. The three macro tokens (`nutrition-protein` **4.92:1**,
`nutrition-carbs` **4.59:1**, `nutrition-fat` **5.19:1** light; **6.77 / 6.59 /
8.51:1** dark) are measured against the same four surfaces. Muted text is at
least **7.48:1** light / **7.39:1** dark. The control keyline `border-strong`
`#947E64` measures **3.38:1** against `surface-raised`, **3.10:1** against the
sunken well and **3.65:1** against the page (all ≥ the 3:1 non-text bar); its
dark counterpart `#A28E80` measures **4.69:1** (well) / **5.36:1** (card).
New families: `saffron` **3.01:1** on the page — a graphic/large-numeral colour
(timer digits are ≥ 20px mono); on a card keyline background it measures **2.78:1**, so
saffron glyphs ride on the page or a saffron tint, never bare on cards — and
`saffron-soft` **11.61:1** on dark card. `espresso` chrome pairs: inactive labels
`chrome-muted` **8.12:1** (light chrome) / **9.04:1** (dark chrome); the active
backplate pill separates from the bar at **13.81:1** with `chrome-backplate-text`
on it at **7.14:1**; the hover accent **6.56:1**; the top edge `chrome-border`
**5.15:1**. `popover` white carries text at **17.09:1**, `popover-dark` at
**14.59:1**. ΔE separations (CIEDE2000): `saffron` ≥ 19.3 from every amber
neighbour (`warning` 27.3, `meal-breakfast` 19.3, `nutrition-energy` 22.3);
`espresso` ≥ 21.1 from `meal-dinner`; `saffron-soft` is ΔE 8.4 from
`meal-breakfast-soft` — the amber space is fully occupied, so the pair is
accepted on non-co-occurrence (timers never share a surface with the breakfast
meal-type chip) plus the glyph/label second signal. These are token-pair checks;
rendered states, opacity, imagery, inheritance and focus must still be tested in
the browser.

Status is not food identity: warnings use `warning` / `warning-soft`, destructive
controls use `danger` / `danger-soft`, favourites remain rose hearts, and a live
household room is signalled with `success` / `success-soft` (ADR-0049). The
success pair is deliberately a **different green** from `hue-vegetarian`
(`#137A38`) and `hue-vegan` (`#047857`) — a "connected" dot must never be
mistaken for a dietary cue. It is also never attached to an `IconRole`, so it
cannot leak into the food-hue registry; it measures **6.66:1** light and
**7.62:1** dark against `surface-sunken`, the chip it actually sits on.
`on-success` is the foreground for a headcount printed ON a `success` fill
(the chip's badge-dot): white on the deep light-mode green, dark green-black
on the light dark-mode green, where white would be ~1.9:1. These foregrounds use raised surfaces; do not assume every status tint works on every
coloured panel. Keep labels or shapes as a second signal. No raw colour literals
in components, ad-hoc Tailwind palette substitutions or undocumented gradients.

A marker may need a family of its own the same way: the **household recipe**
marker uses `household` / `household-soft` (deep plum light, orchid dark). It
is a LABEL, not a food identity: it never joins the `IconRole` registry, and it
is the one non-food family allowed beside the nutrition modal's macro tokens
only because the modal never shows it. Measured **7.40-8.24:1** light and
**5.96-7.51:1** dark across the four surface pairs, and >= 21 deltaE from every
existing family (the nearest, `nutrition-protein`, is modal-only and never on
the same screen). Used by the user-recipe badge on the recipe detail sheet:
`NotebookPen` glyph + the label, `cursor-help` with a title tooltip.

A person avatar (ADR-0063) is generated IDENTITY ART, not a UI colour role: its
palette is produced by the avatar generator and is deliberately exempt from the
token audit the way recipe photography is. Its identity is still bounded by the
system — the generator's `tones` are READ AT RUNTIME from the existing family
tokens (`--color-hue-*`, `--color-meal-*`, `--color-nutrition-*`), so an avatar
never invents a colour the design system does not carry, no hex literal reaches
`src/`, and a future palette change re-skins every avatar for free. The canvas
sits on a `surface-sunken` disc with a `border` keyline so any generated palette
meets a known surface.

## Typography

Two self-hosted typefaces (ADR-0066, supersedes the system-ui-only rule): **Plus
Jakarta Sans** — headlines, labels, body — and **JetBrains Mono**, the DATA voice.
Both ship as latin-subset variable WOFF2 in `src/assets/fonts/` with their OFL
licences, loaded by `@font-face` with `font-display: swap`: zero network requests,
the offline-first rule satisfied by possession.

The ladder (Stitch's scale; `cooking-step` survives ADR-0009):

| Step | Size / leading | Face | Where it belongs |
| --- | --- | --- | --- |
| `display-lg` | 48/56 700 | PJS | Editorial display moments |
| `headline-lg` | 36/44 700 | PJS | Desktop page/recipe titles |
| `headline-lg-mobile` | 28/36 700 | PJS | The same title on a phone |
| `headline-md` | 24/32 700 | PJS | Section heads, mobile recipe titles |
| `headline-sm` | 20/28 700 | PJS | Card-group and dialog heads |
| `body-lg` | 18/28 400 | PJS | Reading body at desktop |
| `body-md` / `body-sm` | 16/1.55 · 14/1.5 400 | PJS | Default / secondary prose |
| `title` | 16/1.4 600 | PJS | Card titles |
| `label-md` | 14/1.4 600 | PJS | Labels, nav tabs, chips |
| `label-sm` | 12/1.4 500 +0.04em | JBM | Small uppercase-style data labels |
| `mono-data` | 13/18 500 | JBM | The DATA voice |
| `cooking-step` | 20/1.6 500 | PJS | The cooking view's one step |

- **Mono is a ROLE, not a decoration:** quantities, cook times, dates, counts,
  room codes, device ids, versions, aisle indices — always `font-mono-data` +
  tabular numerals, units still visible (`kcal`, `min`, `mg sodium`). Prose never
  renders in mono.
- Components consume semantic classes only (`font-mono-data`, `text-headline-*`);
  raw `font-family` declarations in components are not allowed.
- Support 200% zoom and long titles without clipped controls or horizontal scroll.

## Layout

### Shared frame

One fluid `container` token caps the app at **1100px border-box**. Main content
and the content rows of the header and bottom navigation align to it. The header
bar and the bottom bar are FULL-WINDOW chrome (ADR-0065): their backgrounds and
edge borders span the viewport edge to edge on every width — below 1100px this
is already the case — while the logo, room chip, app version and navigation tabs
stay aligned with the content column, making the header symmetric with the
bottom navigation. Use 16px mobile / 24px desktop internal gutters without
adding another narrower container inside the recipe grid.
At 1440px and 1920px desktop widths the app remains centred and actually uses the
1100px allowance. At narrower widths it fits the viewport without horizontal scroll.

Recipe grid: **one column below 360px, two from 360px, three from 720px, four from
1024px**. There is no five-column stage at this cap: the earlier layout made cards
narrower just when their metadata grew. Use 12px gaps on compact phones and 20px
on desktop. Keep food photography at 4:3, larger titles and comfortable padding
(12px mobile / 16px desktop). Do not replace a dense phone grid with giant tiles.

### Recipe detail and task views

At desktop, compose the recipe introduction as photo beside title, key facts and
action panel; stop stretching the photograph into a shallow, screen-wide ribbon.
Below it, ingredients and instructions form an approximately 1:1.5 two-column
reading layout. On phones stack photo, introduction, actions and sections in that
order. Nutrition belongs after the action area, not ahead of the next useful action.

Start cooking is the single primary action. Servings and Add/Update in plan stay
available but are visually secondary. On desktop place actions near the recipe
introduction; on phones use a full-width cooking button and compact secondary
row. A sticky action area is allowed only if it clears the actual app-header
height, does not cover content/focus, and does not consume most of a short screen.
It must reflow for zoom/landscape rather than overlap the navigation.

### One visual language, different jobs

| Surface | Composition and priority | Preserve / avoid |
| --- | --- | --- |
| Recipes | Clear search, compact labelled filters, result count and food grid. Filter groups can breathe without hiding active choices. | Keep sorting, favourites, load-more and a useful zero-results reset. No promotional hero above the controls. |
| Plan | A working list of meal rows with thumbnails, titles and servings; compact summary of existing totals. Auto-Plan is a prominent route to building/completing a plan and carries the ONE filled tomato on this surface. | Never introduce weekday slots. Keep add/replace and plan editing distinct from cooking now. Destructive clear is secondary and confirmed, and Share stays an outline. |
| Auto-Plan dialog | Preferences → generate/regenerate → food preview → confirm. Group controls separately from preview; wider two-zone layout on desktop, logical single column on phones. | Show real pending/busy/error state; a visible old preview is not a finished regeneration. No invented waste percentages or AI sparkles. Preserve undo. |
| Grocery | Store-section headings, strong ingredient names and quantities, provenance beside rather than inside truncated text, real completion progress; Start shopping is the primary action. | Preserve Extra items first, checked/clear semantics and accessible provenance. Amounts come from existing aggregation; never make up savings or quantities. |
| Shopping | Large, high-contrast checkable rows, lightweight section headers, reachable Exit and honest progress. | Keep auto-collapse behaviour, not recipe tiles; no ornamental chrome in a supermarket. |
| Cooking | A focused step reader with measured amounts, visible timers and reachable previous/next/mark/finish controls. | Keep **672px reading measure**, not a narrow browse shell. Never obscure an active timer or add two final completion actions. |
| History | A legible chronological log grouped by plan with plan-created date, recipe thumbnails and individual cook dates/counts. | Preserve ad-hoc and legacy groups. No streak gamification and no invented plan names. |
| Settings | Labelled sections for household sync/privacy, preferences and backup/restore; explicit destructive confirmations. | Local use never requires joining a room. Keep the history-sharing opt-out and backup accessible. |

A live-room status chip is a calm status, not a persistent alarm banner; loss of
sync must never block finding a recipe or checking groceries. Tapping the chip
opens the room roster (ADR-0063) — a calm sheet, not a navigation change — and
the chip keeps every status rule above while gaining the roster affordance.
Empty states name
one useful next action (browse/add meals or generate a plan), without fake data.
Loading/error states use the same surfaces and retain retry affordances.
Keep the existing five labelled bottom tabs and full-screen cooking/shopping
modes. Do not change cooking/history/undo/timer/room/backup semantics.

## Elevation & Depth

**Tonal paper layering** (ADR-0068) — four levels, no shadow ladder:

- **Level 0 — canvas:** the `surface` page `#FBF8F2`.
- **Level 1 — cards/modules:** `surface-raised` paper `#F4EFE6`, 1px `border`
  keyline, 12px radius, **NO drop shadow**. Hover strengthens the keyline
  (`hovercap:`-gated desktop only) — a card never lifts.
- **Level 2 — popovers/sticky bars:** `popover` white + the ONE warm ambient
  shadow `0 8px 24px -4px rgba(43,30,26,0.08)` (`shadow-popover`). The only
  shadow in the app.
- **Level 3 — modals/sheets:** the sheet over the **espresso scrim — espresso at
  45% + `backdrop-filter: blur(6px)`** — the explicit, scoped exception to the
  no-global-blur rule; plain page backgrounds never blur. The scrim is static,
  never animated, so reduced-motion has nothing to disarm.

Photo controls use a **solid espresso disc** (`espresso`, literal dark chrome in
both themes) so the contrast does not depend on photograph brightness; favourite
is an outline heart when idle and a filled `favourite-soft` heart when selected in
BOTH themes. No orange favourite. A `shadow-*` utility on a CARD anywhere in
`src/` is a bug.

## Shapes

12px cards (the index-card radius, ADR-0068); 16px full-screen dialogs and sheets;
12px buttons/inputs and the sunken-well fields; fully rounded (9999px) filter
chips, pills and photo-control discs; 6px checklist boxes and small badges.
Related elements share radii and alignment. Controls have a minimum **44 × 44px
hit target**, even where the visible glyph is 18–22px. Five nav tabs remain at
least 56px high and fit a 412px Pixel 7 without label clipping or requiring
horizontal navigation scrolling.

## Components

### Cards and icon labels

A card is an INDEX CARD resting on the counter (ADR-0068 level 1): `surface-raised`
paper fill, 1px `border` keyline, 12px radius, **no shadow** — the fill tone and
the keyline do the separating. On desktop (`hovercap:` only) hover strengthens the
keyline to `border-strong`; the card never lifts or scales. A `shadow-*` utility
on a card is a bug. A recipe card carries photograph, favourite control, title,
compact facts and rating. Facts are category icon, calories and minutes — numbers
in `font-mono-data` with tabular numerals; use the same hierarchy on phone and
desktop with more breathing room on desktop. Sodium is absent from EVERY browse
card and card-like preview that reuses that compact fact row.

Do not print "Vegetarian", "Meat" or "Fish" beside an already informative type
icon in cards or recipe headers. Keep `role="img"` and an accessible name. Provide
an optional category tooltip on hover/keyboard focus without turning the icon
into a separate action; preserve the full recipe title as the card link name.
Filter buttons KEEP their visible labels because they name a choice. Nutrition
values KEEP units and sodium wording. Decorative icons beside labels are hidden
from assistive technology, so nothing is announced twice.

The whole card must be keyboard navigable with visible focus. Favourite and
rating remain separate real controls, not nested interactive elements inside a
link/button. Touching them must never accidentally open the detail. Preserve
existing load-more and empty/error/loading behaviours.

### Chips — always tinted (ADR-0069)

Chips/pills are 9999px with `0.25rem × 0.75rem` padding — the standard geometry for
every filter, period and aisle-count pill. Dietary/protein chips are **always
tinted**: idle = an 8% semantic-hue tint (`color-mix(in srgb, var(--color-hue-*) 8%,
transparent)`) + the hue's own text — the food hue IS the chip's identity at rest
and on hover. SELECTED = `primary-tint` background + `primary-strong` text:
selection is always brand, never a filled food hue, and the icon's hue stays in
both states. Exclusion diets (`no-pork`, `no-meat`, `no-shellfish`) keep their
explicit wording; the label never drops; an icon carrying state stays queryable
(`aria-pressed`). Non-hue chips (room chip, period pills, aisle counts) keep the
tonal surfaces (`surface-sunken` / `popover`) with `mono-data` numbers.

### Checklists

Checklist boxes (grocery rows, prep lists) are **20px squares with a 6px radius and
a `border-strong` warm keyline**. Checked = tomato fill (`brand`) on grocery, herb
green (`success`) on prep lists, the text struck and muted. The tick never relies
on colour alone — the strikethrough carries the state.

### Selection and actions

Selected filters use the `primary-tint` surface + `primary-strong` text and pressed
semantics, NOT solid tomato behind category-coloured icons. Food icons therefore
keep their identity and remain legible in both states. Apply the same selected
treatment to diet, protein, favourite and other filters; it must not imply all
filter values are food categories. No ambiguous colour-only state and no pill width
jump.

Buttons: the primary tomato keeps a 12px radius (pill allowed on compact controls),
hover is `primary-strong` (never an opacity fade), and the active press scales to
**0.98** — colour-only under `prefers-reduced-motion`. Secondary actions are
outlined on a real surface; destructive controls are danger-outlined AND confirmed.
Start cooking uses a filled tomato surface, white ChefHat + label, 48px minimum
height, and the dark-mode keyline described above. Add/Update in plan uses the
secondary outlined surface. Loading/disabled/focus/hover/pressed states are explicit;
disabled must not look clickable and loading must not collapse the control.
Back and favourite controls stay visible over any photo.

### Fields (inputs and textareas)

Every free-text field — recipe search, ingredient add-rows, settings inputs,
cooking-view scale and note inputs, textareas — speaks ONE sunken-well language
(ADR-0065). At rest the field is a well of `surface-sunken` carrying the typed
value, bounded by the 1px `border-strong` control keyline (`control-border`),
`rounded.lg` 12px, at the 44px touch height. Focus takes the action-text colour
(`primary-strong`, `primary-soft` in dark) on the keyline, beneath the global 2px
focus ring. The well RECESSES into the page where cards LIFT off it: a field
never borrows the recipe-card shadow, and `primary-tint` never fills a field —
tint means selection, and a field is not a selection. All fields share one
component class so the language cannot drift per view; dark mode flips entirely
through the token pairs, never `dark:` utilities. Placeholder and hint text stay
`text-muted`; disabled fields keep the well and mute their text.

### Navigation and motion

The bottom nav sits on the **roasted-espresso bar** (ADR-0067) in BOTH themes —
dark chrome in light mode, as every reviewed render shows. Keep five icons plus
visible labels. An active tab has a modest rounded `chrome-backplate` icon
backplate, `chrome-backplate-text` foreground and `aria-current`, not only a
text-colour change; idle labels use `chrome-muted`. The chrome foreground tokens
are LITERAL (they never flip — the bar is dark in both themes), while the bar
itself flips `espresso` → `espresso-dark`. Tab sizing and hit area stay stable
(ADR-0016's Pixel 7 fit).

Within `@media (hover: hover)` ONLY, hovering the whole tab lifts its icon by
**2px** and tints it to the chrome accent (`chrome-accent`) over **150ms ease**.
Do not move its label/backplate, resize its hit area or animate a whole navigation
bar. `prefers-reduced-motion: reduce` removes the transform; tint may remain. Apply
hover-only affordances only to enabled controls. Keyboard focus has a clear
2px ring with separation from the component in either theme even on devices
without hover. Review other active-scale/pulse transitions for reduced motion.

### Person avatars and the room roster (ADR-0063)

A member of the room is shown as a **`PersonAvatar` canvas** (the `hashvatar`
generator, `dither` mode) beside their name — never initials, never a fetched
image. The generator hashes the person's DISPLAY NAME, so the pattern is
deterministic for everyone who reads it and follows the name when it is edited.
Animation is ON by default (the owner's ask) but collapses to a still pattern
under `prefers-reduced-motion: reduce`, and the render loop is destroyed on
unmount and on every hash change — a looping canvas that outlives its row is a
battery leak, not a decoration.

Sizes are tokens, not ad-hoc numbers: **`avatar` (40px)** wherever the avatar
stands in a row of its own (roster sheet, Settings preview) and
**`avatar-sm` (28px)** inline in compact rows. Both clip to a circle
(`rounded.full`) over a `surface-sunken` disc with a `border` keyline. The
roster is small and personal, not a leader board: names render Title Case at
`body-sm`, two people MAY share a name (conflicts are allowed; with the name as
hash input, identical names render the identical pattern BY DESIGN — the
quiet "you" marker and context disambiguate, never a colour change), and the
roster NEVER
ranks, counts contributions or gamifies presence.

The roster sheet opens by tapping the **live room chip**, which stops being a
pure status: the chip becomes a real button (`aria-expanded`, keeps its
TooltipBubble description, keeps the `cursor-help` affordance semantics). The
sheet header states the relay's live count ("N in room"); each row is the
member's avatar + name, with a quiet "you" marker on the device's own row —
text, never a colour-only distinction. Presence is the relay's live truth: the
sheet shows who is CONNECTED NOW, not who has ever been in the household, and
empty roster data degrades to the plain count, never a fake member list.

### Verification and implementation contract

1. Read ADR-0036 before new semantic implementation; it records why this revision
   supersedes the accent-only, frozen-mobile and five-column constraints. Keep
   ADR-0035 as history with a superseded-by pointer, not a rewritten decision.
2. Mirror ALL used design tokens (including surfaces/text/borders) into Tailwind;
   use static complete class strings for roles so dark CSS is emitted. Document
   the small `primary` → `brand` naming translation once. Update the generated
   DTCG export and deterministic token-parity checks together.
3. Use one role registry for glyph, accessible name and colours. Test vegetarian
   and vegan as distinct roles/glyphs and exclusion labels as exclusions, not as
   guessed ingredients. Test actual computed SVG styles, not source strings alone.
4. Cover light AND dark browser states at 360px/412px phones, 768px tablet and
   1440px/1920px desktop, plus a narrow 320px viewport and 200% zoom. Check grid
   columns, full-shell width, wrapping, overlays, labels, hit areas and navigation.
5. Add regressions for readable Start cooking background/foreground/keyline;
   primary-vs-secondary hierarchy; no repeated type labels; sodium absent from
   cards but present when supplied in nutrition; consistent icons; hover lift,
   keyboard focus and reduced motion. Check pressed filters, not only idle icons.
6. Capture and REVIEW before/after screenshots in both themes (browse, detail,
   representative plan/grocery/history/settings and cooking). A screenshot saved
   but not inspected is not visual verification. Do not bless blank/loading pages.
7. Run document lint, build, unit tests and the complete Playwright suite serially
   against the built bundle. No previously passing result proves the new revision.
   Report actual counts/skips/failures; never weaken a behavioural test just to
   match new markup. Use existing offline request guards and `data-test` hooks.

## Do's and Don'ts

- Do rethink composition and hierarchy where it helps cooking or choosing food.
- Do keep a warm coherent light theme AND a fully legible dark theme.
- Do colour meaningful actions and selections as well as icons; several semantic
  icon colours may coexist in a metadata row without making the whole card rainbow.
- Do preserve data, quantities, dietary-filter semantics and existing workflows.
- Don't restore the old grey-only or forced-dark card treatment in light mode.
- Don't shrink desktop cards to five columns or body text to squeeze in more facts.
- Don't duplicate category words, put sodium back on browse cards, or reuse the
  vegan sprout as the vegetarian icon.
- Don't confuse a token lint pass with rendered accessibility or implementation
  completion. Verify real surfaces and all entry points before making that claim.
