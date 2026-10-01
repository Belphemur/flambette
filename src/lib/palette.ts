/**
 * The icon ROLE registry — one glyph, one accessible name and one colour
 * per meaning, for EVERY call site (ADR-0036 item 5).
 *
 * `DESIGN.md` (repo root) is the single source of truth: it lists the
 * glyph and token of each role in the "Food and nutrition identities"
 * table, and `src/style.css` mirrors the token VALUES into Tailwind's
 * `@theme`. This module is the typed map in between, so a filter chip, a
 * recipe card, a detail header and a plan preview cannot drift into two
 * different glyphs for "vegetarian".
 *
 * Two things are deliberate here:
 *
 *  - **Vegetarian is NOT vegan.** They are separate roles with separate
 *  tokens (`hue-vegetarian` vs `hue-vegan`) and separate glyphs (a
 *  green salad bowl vs a mint sprout). DESIGN.md is explicit that a
 *  catalog category is never a vegan certification, so the registry
 *  must not imply one.
 *  - **A hue is identity, never state.** Nothing in this file knows
 *  whether a chip is selected; selection is painted by the component
 *  with `brand-tint` + a brand outline (DESIGN.md `chip-selected`).
 *
 * Dark mode needs no `dark:` variant per role: the `@theme` variable
 * re-points at its `-soft` counterpart under `.dark`, so one literal
 * class name is correct in both themes and an unstyled dark state is
 * structurally impossible.
 */

import { Beef, Droplet, Fish, Flame, Salad, Sprout, type LucideIcon } from 'lucide-vue-next'

/** The six roles that own a glyph and a colour: four categorical, two semantic. */
export type IconRole = 'meat' | 'fish' | 'vegetarian' | 'vegan' | 'energy' | 'sodium'

/** Ingredient types the catalog actually publishes (`variant_data.category_name`). */
export type IngredientType = 'meat' | 'fish' | 'vegetarian'

export interface IconRoleSpec {
  /** Categorical roles answer "what kind of food"; semantic ones answer "what does this number mean". */
  kind: 'categorical' | 'semantic'
  /** DESIGN.md token name (light value) — the documentation contract. */
  token: string
  /** DESIGN.md token name the dark theme resolves this role to. */
  darkToken: string
  /**
  * Tailwind text utility for the role. Spelled out LITERALLY, never
  * interpolated from `token`: Tailwind scans source TEXT for complete
  * class names, so a generated `text-${token}` emits no CSS at all.
  */
  className: string
  /** Accessible name wherever the icon is the carrier of the meaning. */
  label: string
  /** The Lucide glyph DESIGN.md assigns to this role. */
  glyph: 'beef' | 'fish' | 'salad' | 'sprout' | 'flame' | 'droplet'
}

/** The whole role contract: role -> glyph + name + colour. Exhaustive by type. */
export const ICON_ROLES: Record<IconRole, IconRoleSpec> = {
  meat: {
  kind: 'categorical',
  token: 'hue-meat',
  darkToken: 'hue-meat-soft',
  className: 'text-hue-meat',
  label: 'Meat',
  glyph: 'beef',
  },
  fish: {
  kind: 'categorical',
  token: 'hue-fish',
  darkToken: 'hue-fish-soft',
  className: 'text-hue-fish',
  label: 'Fish',
  glyph: 'fish',
  },
  vegetarian: {
  kind: 'categorical',
  token: 'hue-vegetarian',
  darkToken: 'hue-vegetarian-soft',
  className: 'text-hue-vegetarian',
  label: 'Vegetarian',
  glyph: 'salad',
  },
  vegan: {
  kind: 'categorical',
  token: 'hue-vegan',
  darkToken: 'hue-vegan-soft',
  className: 'text-hue-vegan',
  label: 'Vegan',
  glyph: 'sprout',
  },
  energy: {
  kind: 'semantic',
  token: 'nutrition-energy',
  darkToken: 'nutrition-energy-soft',
  className: 'text-nutrition-energy',
  label: 'Energy',
  glyph: 'flame',
  },
  sodium: {
  kind: 'semantic',
  token: 'nutrition-sodium',
  darkToken: 'nutrition-sodium-soft',
  className: 'text-nutrition-sodium',
  label: 'Sodium',
  glyph: 'droplet',
  },
}

/** The Lucide component for each role's glyph. One map, every call site. */
export const ROLE_GLYPHS: Record<IconRoleSpec['glyph'], LucideIcon> = {
  beef: Beef,
  fish: Fish,
  salad: Salad,
  sprout: Sprout,
  flame: Flame,
  droplet: Droplet,
}

/** Tailwind text utilities for a role (`text-hue-fish`; dark follows the theme). */
export function hueClass(role: IconRole): string {
  return ICON_ROLES[role].className
}

/** The Lucide component for a role, for the rare call site that renders
 *  its own `<component :is>` (e.g. a chip that sizes the glyph itself). */
export function roleGlyph(role: IconRole): LucideIcon {
  return ROLE_GLYPHS[ICON_ROLES[role].glyph]
}

/**
 * The categorical role for a catalog category name. The catalog publishes
 * exactly three (`meat`, `fish`, `vegetarian`), so this is an exact match
 * and never a keyword guess: an unknown or absent category is "no type
 * icon", not a fallback hue. `vegan` is a DIET filter, not a catalog
 * category, so it is never returned here.
 */
export function ingredientRole(category: string | null | undefined): IconRole | null {
  if (category === 'meat') return 'meat'
  if (category === 'fish') return 'fish'
  if (category === 'vegetarian') return 'vegetarian'
  return null
}

/** The categorical role for a quick-filter protein value (`''` = any = none). */
export function proteinRole(protein: string): IconRole | null {
  return protein === '' ? null : ingredientRole(protein)
}

/**
 * The text utilities for a quick-filter protein value — the SINGLE
 * protein → hue mapping shared by the filter chips and the recipe card.
 * `''` ("any protein") is not a food, so it wears no hue and returns `''`.
 */
export function proteinHueClass(protein: string): string {
  const role = proteinRole(protein)
  return role === null ? '' : hueClass(role)
}

/**
 * The role a diet filter is ABOUT. Exclusion diets (`no-pork`,
 * `no-shellfish`, `no-meat`) are about a protein, so they borrow that
 * protein's role; `vegetarian` and `vegan` are positive diets and have
 * their own two roles. The chip KEEPS its explicit wording ("No-pork"),
 * because an exclusion is never communicated by a red icon alone.
 */
export function dietRole(diet: string): IconRole | null {
  if (diet === 'no-pork' || diet === 'no-meat') return 'meat'
  if (diet === 'no-shellfish') return 'fish'
  if (diet === 'vegetarian') return 'vegetarian'
  if (diet === 'vegan') return 'vegan'
  return null
}

/**
 * The text utilities for a diet id, from the same single mapping, so a
 * chip's glyph and its colour can never disagree. An unknown diet wears
 * no hue rather than a guessed one.
 */
export function dietHueClass(diet: string): string {
  const role = dietRole(diet)
  return role === null ? '' : hueClass(role)
}