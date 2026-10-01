/**
 * Icon hues — the categorical and semantic colour contract (ADR-0035).
 *
 * `DESIGN.md` (repo root) is the single source of truth for the palette;
 * this module is the typed map from a SEMANTIC ROLE to the design tokens
 * it wears, so a component never invents a colour and never inlines a raw
 * hex. The classes below are generated from the token names, which the
 * `@theme` block in `src/style.css` mirrors:
 *
 *   `--color-hue-meat`      -> `text-hue-meat`
 *   `--color-hue-meat-soft` -> `dark:text-hue-meat-soft`
 *
 * A hue is an icon's IDENTITY, never its state: a selected filter chip
 * keeps its food hue. Selection is always the primary token (DESIGN.md
 * `chip-selected`).
 */

/** The five roles that own a colour: three categorical, two semantic. */
export type IconRole = 'meat' | 'fish' | 'vegan' | 'energy' | 'sodium'

/** Ingredient types the catalog actually publishes (`variant_data.category_name`). */
export type IngredientType = 'meat' | 'fish' | 'vegetarian'

export interface IconHue {
  /** Categorical roles answer "what kind of food"; semantic ones answer "what does this number mean". */
  kind: 'categorical' | 'semantic'
  /** DESIGN.md token name (light surface) — the documentation contract. */
  token: string
  /** DESIGN.md token name for the dark surface. */
  darkToken: string
  /** Tailwind text utilities: light, then the dark-surface variant. */
  className: string
  /** Accessible name for the icon wherever it is the only carrier of meaning. */
  label: string
}

function hue(kind: IconHue['kind'], token: string, label: string): IconHue {
  return {
    kind,
    token,
    darkToken: `${token}-soft`,
    className: `text-${token} dark:text-${token}-soft`,
    label,
  }
}

/** The whole palette contract: role -> design tokens. Exhaustive by type. */
export const ICON_HUES: Record<IconRole, IconHue> = {
  meat: hue('categorical', 'hue-meat', 'Meat'),
  fish: hue('categorical', 'hue-fish', 'Fish'),
  vegan: hue('categorical', 'hue-vegan', 'Vegetarian'),
  energy: hue('semantic', 'nutrition-energy', 'Energy'),
  sodium: hue('semantic', 'nutrition-sodium', 'Sodium'),
}

export const ICON_ROLES = Object.keys(ICON_HUES) as IconRole[]

/** Tailwind text utilities for a role (`text-hue-fish dark:text-hue-fish-soft`). */
export function hueClass(role: IconRole): string {
  return ICON_HUES[role].className
}

/**
 * The categorical role for a catalog category name. The catalog publishes
 * exactly three (`meat`, `fish`, `vegetarian`), so this is an exact match
 * and never a keyword guess: an unknown or absent category is "no type
 * icon", not a fallback hue.
 */
export function ingredientRole(category: string | null | undefined): IconRole | null {
  if (category === 'meat') return 'meat'
  if (category === 'fish') return 'fish'
  if (category === 'vegetarian') return 'vegan'
  return null
}

/** The categorical role for a quick-filter protein value (`''` = any = none). */
export function proteinRole(protein: string): IconRole | null {
  return protein === '' ? null : ingredientRole(protein)
}