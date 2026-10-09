/**
 * The aisle band's leading icon (ADR-0071).
 *
 * The band is the reading-surface grammar's section header: a food-hue
 * glyph, the section name, the derived `(Aisle N)` index and the mono
 * `N/M` pill. The glyph and its colour come from the ONE role registry
 * (`src/lib/palette.ts`, ADR-0036) — never from a second icon→hue map
 * living in a component.
 *
 * Why only two aisles carry a hue. The registry answers two questions and
 * nothing else: "what kind of food is this" (ingredient type) and "what
 * does this number mean" (nutrition). A store DEPARTMENT is a third
 * thing, and the registry can only speak about it where the department's
 * identity IS one of the identities it already claims:
 *
 *  - Produce is vegetables, fruit and herbs — the `vegetarian` role's own
 *    claim, so the green is the aisle's identity, not a guess.
 *  - Meat & Seafood is the `meat` role's claim, and the aisle says so in
 *    its own name.
 *
 * Every other section (Bakery, Dairy, Frozen, Pantry, …) has no registry
 * home, so it renders NO glyph rather than borrowing someone else's hue:
 * lending `hue-vegetarian` to "Baking & Spices" or a meal-occasion hue
 * to "Coffee & Tea" would make one colour answer two questions on the
 * same screen, which is exactly the collision ADR-0036 (and ADR-0072's
 * done-state ruling) exist to prevent. An absent glyph is the honest
 * absence; the section NAME stays, because the label always stays.
 *
 * These are DEPARTMENT identities, never state: nothing here knows
 * whether a row is checked, and a checked row's success fill (ADR-0072)
 * is painted by the row, not by the band.
 */

import type { StoreSection } from './sections'
import type { IconRole } from './palette'

/** Aisle → registry role, or null for "this department wears no hue". */
const AISLE_ROLES: Partial<Record<StoreSection, IconRole>> = {
  Produce: 'vegetarian',
  'Meat & Seafood': 'meat',
}

/**
 * The registry role for a store section, or null when the registry cannot
 * express that department honestly. Total by construction — a new
 * `STORE_SECTIONS` entry gets `null` (no glyph) until someone adds it
 * here deliberately.
 */
export function aisleRole(section: StoreSection): IconRole | null {
  return AISLE_ROLES[section] ?? null
}
