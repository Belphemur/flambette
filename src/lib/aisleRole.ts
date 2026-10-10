/**
 * The store department's leading icon — glyph AND colour (ADR-0076).
 *
 * The grocery band is the reading-surface grammar's section header: a
 * glyph, the section name, the derived `(Aisle N)` index and the mono
 * `N/M` pill. The owner ruled EVERY grocery category carries an icon —
 * in the aisle bands, in the extras sub-sections, in the add-extra
 * picker and in the autocomplete's per-row category pill — and then
 * ruled every category also carries a COLOUR, like Meat & Seafood's red
 * and Produce's green.
 *
 * The colour lives HERE, in one table next to the glyph, so no
 * component keeps its own icon→hue map (ADR-0036's one-registry rule):
 *
 *  - Produce and Meat & Seafood are identity-claimed by the FOOD
 *    registry (`src/lib/palette.ts`): they wear `text-hue-vegetarian` /
 *    `text-hue-meat`, so an aisle band and a protein chip can never
 *    disagree about what green or red means.
 *  - The other 29 departments wear the measured `aisle-*` family
 *    (DESIGN.md "Store department (aisle) hues", ADR-0076): 14 light/dark
 *    token pairs, kindred departments deliberately ALIASING one token —
 *    never adjacent in `STORE_SECTIONS` order. Inside a family the glyph
 *    shape and the printed name carry identity; the hue groups kindred
 *    aisles at a glance.
 *
 * Aisle hues are DEPARTMENT identities, never state: nothing here knows
 * whether a row is checked, and a checked row's success fill (ADR-0072)
 * is painted by the row, not by the band. They also never join the
 * `IconRole` registry — a department is a third question beside "what
 * kind of food" and "what does this number mean".
 *
 * Every class name is a LITERAL complete utility: Tailwind scans source
 * TEXT for class names, so an interpolated `text-${token}` emits no CSS
 * (the same rule `palette.ts` documents). Dark mode needs no `dark:`
 * variant — the `.dark` block in `src/style.css` re-points each
 * `--color-aisle-*` at its `-soft` counterpart.
 *
 * The glyphs are all `lucide-vue-next` icons, bundled per ADR-0029;
 * each was verified against the package's shipped icon set. Lucide has
 * no honey jar, no cheese wheel and no plain bottle, so the nearest
 * honest shapes are used: `Nut` for nut butters (the name's own word),
 * `CookingPot` for canned & jarred (their contents simmer), `Soup` for
 * pasta sauces.
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

/** One department's icon: the glyph plus the literal colour utility. */
export interface AisleIcon {
  glyph: LucideIcon
  className: string
}

/**
 * The department colour per section — literal `text-*` utilities, total
 * over `STORE_SECTIONS`. The two registry-claimed departments reference
 * the FOOD registry's tokens; the rest wear `aisle-*`.
 */
const AISLE_HUES: Record<StoreSection, string> = {
  Produce: 'text-hue-vegetarian',
  'Deli & Specialty Cheese': 'text-aisle-gold',
  Bakery: 'text-aisle-crust',
  'Meat & Seafood': 'text-hue-meat',
  'Dairy, Cheese & Eggs': 'text-aisle-royal',
  Breakfast: 'text-aisle-sunrise',
  'Coffee & Tea': 'text-aisle-coffee',
  'Nut Butters, Honey & Jams': 'text-aisle-gold',
  'Baking & Spices': 'text-aisle-crust',
  'Rice, Grains & Beans': 'text-aisle-husk',
  'Canned & Jarred Goods': 'text-aisle-slate',
  'Pasta & Sauces': 'text-aisle-gold',
  'Oils, Sauces & Condiments': 'text-aisle-husk',
  International: 'text-aisle-royal',
  Frozen: 'text-aisle-ice',
  Snacks: 'text-aisle-sunrise',
  'Nuts, Seeds & Dried Fruit': 'text-aisle-coffee',
  Candy: 'text-aisle-rose',
  Beverages: 'text-aisle-violet',
  'Wine, Beer & Spirits': 'text-aisle-wine',
  'Personal Care': 'text-aisle-lavender',
  Health: 'text-aisle-leaf',
  Baby: 'text-aisle-sunrise',
  Household: 'text-aisle-slate',
  Kitchen: 'text-aisle-stone',
  'Cleaning Products': 'text-aisle-leaf',
  'Pet Care': 'text-aisle-crust',
  Party: 'text-aisle-violet',
  Floral: 'text-aisle-rose',
  'Customer Service': 'text-aisle-slate',
  Other: 'text-aisle-stone',
}

/** The department glyph per section — total over `STORE_SECTIONS`. */
const AISLE_GLYPHS: Record<StoreSection, LucideIcon> = {
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

/**
 * The icon for a store-section name — every `STORE_SECTIONS` member
 * returns an entry; anything else (e.g. the extras group's
 * `Uncategorized` bucket, which is a view label, not a department)
 * returns null and the call site renders no glyph. Total over
 * `STORE_SECTIONS` by construction: a new section without a table entry
 * is a broken unit test, never a missing or uncoloured icon in
 * production.
 */
export function aisleIcon(section: string): AisleIcon | null {
  if (!(STORE_SECTIONS as readonly string[]).includes(section)) return null
  const name = section as StoreSection
  return { glyph: AISLE_GLYPHS[name], className: AISLE_HUES[name] }
}
