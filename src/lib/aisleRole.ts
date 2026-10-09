/**
 * The aisle band's leading icon (ADR-0071 + the owner's every-category
 * addendum).
 *
 * The band is the reading-surface grammar's section header: a glyph, the
 * section name, the derived `(Aisle N)` index and the mono `N/M` pill.
 * The owner ruled EVERY grocery category carries an icon — in the aisle
 * bands, in the extras sub-sections, in the add-extra picker and in the
 * autocomplete's per-row category pill. The glyphs live HERE, in one
 * table next to the hue mapping, so no component keeps its own
 * icon→hue map (ADR-0036's one-registry rule).
 *
 * Colour stays a REGISTRY decision, not a glyph decision (ADR-0036): the
 * registry answers "what kind of food is this" (ingredient type) and
 * "what does this number mean" (nutrition). A store DEPARTMENT is a
 * third thing, so only two aisles wear a hue — the two whose identity
 * the registry already claims:
 *
 *  - Produce is vegetables, fruit and herbs — the `vegetarian` role's own
 *    claim, so the green is the aisle's identity, not a guess.
 *  - Meat & Seafood is the `meat` role's claim, and the aisle says so in
 *    its own name.
 *
 * Every OTHER department renders its glyph in the muted ink colour:
 * identity comes from the glyph's SHAPE, never from a borrowed hue —
 * lending `hue-vegetarian` to "Baking & Spices" or a meal-occasion hue to
 * "Coffee & Tea" would make one colour answer two questions on the same
 * screen, exactly the collision ADR-0036 (and ADR-0072's done-state
 * ruling) exist to prevent. The glyphs are all `lucide-vue-next` icons,
 * bundled per ADR-0029; each name below was verified against the
 * package's shipped icon set.
 *
 * These are DEPARTMENT identities, never state: nothing here knows
 * whether a row is checked, and a checked row's success fill (ADR-0072)
 * is painted by the row, not by the band.
 */

import {
  Baby,
  Bean,
  Beef,
  CakeSlice,
  Candy,
  ChefHat,
  Coffee,
  CookingPot,
  Croissant,
  CupSoda,
  Droplets,
  EggFried,
  Flower,
  Globe,
  LifeBuoy,
  Milk,
  Nut,
  Package,
  PartyPopper,
  PawPrint,
  PillBottle,
  Popcorn,
  Salad,
  Sandwich,
  ShowerHead,
  Snowflake,
  Soup,
  SprayCan,
  WashingMachine,
  Wheat,
  Wine,
  type LucideIcon,
} from 'lucide-vue-next'
import { STORE_SECTIONS, type StoreSection } from './sections'
import type { IconRole } from './palette'

/** Aisle → registry role, or null for "this department wears no hue". */
const AISLE_ROLES: Partial<Record<StoreSection, IconRole>> = {
  Produce: 'vegetarian',
  'Meat & Seafood': 'meat',
}

/**
 * EVERY department gets a glyph (owner ruling). Lucide has no honey jar,
 * no cheese wheel and no plain bottle, so the nearest honest shapes are
 * used: `Nut` for nut butters (the name's own word), `CookingPot` for
 * canned & jarred (their contents simmer), `Soup` for pasta sauces.
 */
const AISLE_GLYPHS: Record<StoreSection, LucideIcon> = {
  // Produce / Meat & Seafood carry BOTH a glyph and a registry role: the
  // glyph is the department's true shape (the role's own glyph), the role
  // adds the hue. A call site that renders `.glyph` alone is still
  // correct — only the colour differs from the HueIcon path.
  Produce: Salad,
  'Deli & Specialty Cheese': Sandwich,
  Bakery: Croissant,
  'Meat & Seafood': Beef,
  'Dairy, Cheese & Eggs': Milk,
  Breakfast: EggFried,
  'Coffee & Tea': Coffee,
  'Nut Butters, Honey & Jams': Nut,
  'Baking & Spices': CakeSlice,
  'Rice, Grains & Beans': Wheat,
  'Canned & Jarred Goods': CookingPot,
  'Pasta & Sauces': Soup,
  'Oils, Sauces & Condiments': Droplets,
  International: Globe,
  Frozen: Snowflake,
  Snacks: Popcorn,
  'Nuts, Seeds & Dried Fruit': Bean,
  Candy: Candy,
  Beverages: CupSoda,
  'Wine, Beer & Spirits': Wine,
  'Personal Care': ShowerHead,
  Health: PillBottle,
  Baby: Baby,
  Household: WashingMachine,
  Kitchen: ChefHat,
  'Cleaning Products': SprayCan,
  'Pet Care': PawPrint,
  Party: PartyPopper,
  Floral: Flower,
  'Customer Service': LifeBuoy,
  Other: Package,
}

/** One department's icon: the glyph, plus the registry role it wears (if any). */
export interface AisleIcon {
  glyph: LucideIcon
  role: IconRole | null
}

/**
 * The icon for a store-section name — every `STORE_SECTIONS` member
 * returns an entry; anything else (e.g. the extras group's
 * `Uncategorized` bucket, which is a view label, not a department)
 * returns null and the call site renders no glyph. Total over
 * `STORE_SECTIONS` by construction: a new section without a table entry
 * is a broken unit test, never a missing icon in production.
 */
export function aisleIcon(section: string): AisleIcon | null {
  if (!(STORE_SECTIONS as readonly string[]).includes(section)) return null
  const name = section as StoreSection
  return { glyph: AISLE_GLYPHS[name], role: AISLE_ROLES[name] ?? null }
}

/**
 * The registry role for a store section, or null when the registry cannot
 * express that department honestly. Kept as the hue-only read for call
 * sites that render through `HueIcon` (it wants the role, not the glyph).
 */
export function aisleRole(section: StoreSection): IconRole | null {
  return AISLE_ROLES[section] ?? null
}
