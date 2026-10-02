/**
 * Per-serving nutrition facts for the recipe detail's facts modal
 * (ADR-0039), derived entirely from the OFFLINE recipe document's
 * `nutrition` block.
 *
 * Two jobs, both pure so they can be unit-tested without a component:
 *
 *  1. `macroSplit` — the percent-of-calories split behind the donut.
 *     It is DERIVED (4 kcal/g carbs + protein, 9 kcal/g fat) and it can
 *     return `null`: a catalog entry whose macro calories do not
 *     account for the stated energy gets the calories and the word
 *     "split not derivable", never a fabricated ring.
 *  2. `NUTRITION_GROUPS` — the 66 published keys mapped onto the display
 *     groups, their display names and their units. The catalog is
 *     FROZEN, so this table is exhaustive and the modal's row list is a
 *     projection of it, never a per-component hand list.
 *
 * Facts are PER SERVING (ADR-0004): nothing here is scaled by the
 * detail's servings stepper — only totals scale.
 */

import type { Nutrition } from './types'

/** Atwater factors, kcal per gram. */
export const KCAL_PER_G = { fat: 9, carbs: 4, protein: 4 } as const

/**
 * Fiber's NET Atwater factor. USDA counts fiber at 4 kcal/g for the food
 * energy total, but a good part of it is not metabolised, so the 2 kcal/g
 * net factor is what the ESTIMATE uses: carbohydrate that is fiber is
 * charged 4 - 2 = 2 kcal/g here. Without this a high-fiber recipe
 * overshoots the stated energy and loses its donut (recipe 9148: 746 kcal
 * derived against 701 published, versus 702 once fiber is charged at
 * 2 kcal/g).
 */
export const KCAL_PER_G_FIBER_NET = 2

/**
 * How far the three macro calorie contributions may sit from the stated
 * energy before the split is refused. Catalog rounding, the fiber
 * adjustment above and a sugar-alcohol discrepancy land well inside 12%;
 * a genuinely mislabelled entry does not.
 */
export const SPLIT_TOLERANCE = 0.12

export interface MacroSplit {
  /** 0..1, sum-normalised. */
  fatPct: number
  carbPct: number
  proteinPct: number
}

/**
 * Percent-of-calories split, or `null` when it cannot be derived
 * honestly: no energy, a negative macro, or a triple that does not
 * account for the stated energy within `SPLIT_TOLERANCE`.
 */
export function macroSplit(n: Nutrition | null | undefined): MacroSplit | null {
  if (!n) return null
  const energy = num(n.energy)
  const fat = num(n.fat)
  const carbs = num(n.carbs)
  const protein = num(n.protein)
  const fiber = Math.min(Math.max(num(n.fiber), 0), carbs)
  if (!(energy > 0)) return null
  if (fat < 0 || carbs < 0 || protein < 0) return null
  const raw = {
    fatPct: (KCAL_PER_G.fat * fat) / energy,
    // Fiber is carbohydrate that costs 2 kcal/g net, not 4.
    carbPct: (KCAL_PER_G.carbs * carbs - (KCAL_PER_G.carbs - KCAL_PER_G_FIBER_NET) * fiber) / energy,
    proteinPct: (KCAL_PER_G.protein * protein) / energy,
  }
  const total = raw.fatPct + raw.carbPct + raw.proteinPct
  if (!(total > 0)) return null
  if (Math.abs(total - 1) > SPLIT_TOLERANCE) return null
  return {
    fatPct: raw.fatPct / total,
    carbPct: raw.carbPct / total,
    proteinPct: raw.proteinPct / total,
  }
}

export type NutritionUnit = 'kcal' | 'g' | 'mg' | 'µg'

/**
 * The published unit of EVERY catalog key, enumerated over the 66-key
 * catalog (magnitudes sanity-checked against `public/data/recipes/*.json`
 * per serving: vitamin C 52 mg, calcium 190 mg, potassium 1190 mg,
 * selenium 44 µg, folate 146 µg, amino acids ~1.8 g).
 *
 * The default in `unitFor` stays `g` for defensive robustness against a
 * future key, but `assertUnitTableComplete` (unit-tested) fails the build
 * if a known key ever falls through to it — a "full nutrition facts" panel
 * that prints `1048 g potassium` is worse than no row at all.
 */
export const NUTRITION_UNITS: Record<string, NutritionUnit> = {
  energy: 'kcal',
  // mg — electrolytes, cholesterol and the water-soluble vitamins.
  sodium: 'mg',
  cholesterol: 'mg',
  vitamin_c: 'mg',
  vitamin_e: 'mg',
  b1_thiamine: 'mg',
  b2_riboflavin: 'mg',
  b3_niacin: 'mg',
  b5_pantothenic_acid: 'mg',
  b6_pyridoxine: 'mg',
  choline: 'mg',
  // mg — minerals.
  calcium: 'mg',
  copper: 'mg',
  iron: 'mg',
  magnesium: 'mg',
  manganese: 'mg',
  phosphorus: 'mg',
  potassium: 'mg',
  zinc: 'mg',
  // µg — fat-soluble vitamins, B12, folate and selenium.
  vitamin_a: 'µg',
  vitamin_d: 'µg',
  vitamin_k: 'µg',
  b12_cobalamin: 'µg',
  folate: 'µg',
  selenium: 'µg',
  // mg — a stimulant measured in milligrams, never grams (catalog max 25.5).
  caffeine: 'mg',
  // g — everything else: macros, sugars, amino acids and the bulk rows.
  protein: 'g',
  carbs: 'g',
  fat: 'g',
  saturated: 'g',
  monounsaturated: 'g',
  polyunsaturated: 'g',
  omega_3: 'g',
  omega_6: 'g',
  transfats: 'g',
  starch: 'g',
  fiber: 'g',
  sugars: 'g',
  fructose: 'g',
  galactose: 'g',
  glucose: 'g',
  lactose: 'g',
  maltose: 'g',
  sucrose: 'g',
  sugar_alcohol: 'g',
  alanine: 'g',
  arginine: 'g',
  aspartic_acid: 'g',
  cystine: 'g',
  glutamic_acid: 'g',
  glycine: 'g',
  histidine: 'g',
  isoleucine: 'g',
  leucine: 'g',
  lysine: 'g',
  methionine: 'g',
  phenylalanine: 'g',
  proline: 'g',
  serine: 'g',
  threonine: 'g',
  tryptophan: 'g',
  tyrosine: 'g',
  valine: 'g',
  water: 'g',
  ash: 'g',
  alcohol: 'g',
}

export function unitFor(key: string): NutritionUnit {
  return NUTRITION_UNITS[key] ?? 'g'
}

/**
 * Every key the facts layout can render must have an EXPLICIT unit — a
 * missing entry silently prints the wrong unit. Returns the offending
 * keys (empty when the table is complete) so a unit test can assert it.
 */
export function unknownUnitKeys(keys: readonly string[] = NUTRITION_KEYS): string[] {
  return keys.filter((key) => NUTRITION_UNITS[key] === undefined)
}

export interface NutritionRow {
  /** The published `nutrition` key. */
  key: string
  /** Human label; never a raw snake_case key. */
  label: string
  unit: NutritionUnit
  value: number
}

export interface NutritionGroup {
  /** Group id, also the `data-test` slug. */
  id: string
  title: string
  /** Collapsed until the user asks (a 66-row wall is not a facts panel). */
  collapsedByDefault: boolean
  rows: NutritionRow[]
}

interface RowSpec {
  key: string
  label: string
}

const MACROS: RowSpec[] = [
  { key: 'carbs', label: 'Carbohydrates' },
  { key: 'starch', label: 'Starch' },
  { key: 'fiber', label: 'Fibre' },
]

const SUGARS: RowSpec[] = [
  { key: 'sugars', label: 'Sugars' },
  { key: 'fructose', label: 'Fructose' },
  { key: 'galactose', label: 'Galactose' },
  { key: 'glucose', label: 'Glucose' },
  { key: 'lactose', label: 'Lactose' },
  { key: 'maltose', label: 'Maltose' },
  { key: 'sucrose', label: 'Sucrose' },
]

const FATS: RowSpec[] = [
  { key: 'fat', label: 'Total fat' },
  { key: 'saturated', label: 'Saturated' },
  { key: 'monounsaturated', label: 'Monounsaturated' },
  { key: 'polyunsaturated', label: 'Polyunsaturated' },
  { key: 'omega_3', label: 'Omega-3' },
  { key: 'omega_6', label: 'Omega-6' },
  { key: 'transfats', label: 'Trans fats' },
  { key: 'cholesterol', label: 'Cholesterol' },
]

const AMINO_ACIDS: RowSpec[] = [
  { key: 'alanine', label: 'Alanine' },
  { key: 'arginine', label: 'Arginine' },
  { key: 'aspartic_acid', label: 'Aspartic acid' },
  { key: 'cystine', label: 'Cystine' },
  { key: 'glutamic_acid', label: 'Glutamic acid' },
  { key: 'glycine', label: 'Glycine' },
  { key: 'histidine', label: 'Histidine' },
  { key: 'isoleucine', label: 'Isoleucine' },
  { key: 'leucine', label: 'Leucine' },
  { key: 'lysine', label: 'Lysine' },
  { key: 'methionine', label: 'Methionine' },
  { key: 'phenylalanine', label: 'Phenylalanine' },
  { key: 'proline', label: 'Proline' },
  { key: 'serine', label: 'Serine' },
  { key: 'threonine', label: 'Threonine' },
  { key: 'tryptophan', label: 'Tryptophan' },
  { key: 'tyrosine', label: 'Tyrosine' },
  { key: 'valine', label: 'Valine' },
]

const VITAMINS: RowSpec[] = [
  { key: 'vitamin_a', label: 'Vitamin A' },
  { key: 'vitamin_c', label: 'Vitamin C' },
  { key: 'vitamin_d', label: 'Vitamin D' },
  { key: 'vitamin_e', label: 'Vitamin E' },
  { key: 'vitamin_k', label: 'Vitamin K' },
  { key: 'b1_thiamine', label: 'B1 (thiamine)' },
  { key: 'b2_riboflavin', label: 'B2 (riboflavin)' },
  { key: 'b3_niacin', label: 'B3 (niacin)' },
  { key: 'b5_pantothenic_acid', label: 'B5 (pantothenic acid)' },
  { key: 'b6_pyridoxine', label: 'B6 (pyridoxine)' },
  { key: 'b12_cobalamin', label: 'B12 (cobalamin)' },
  { key: 'choline', label: 'Choline' },
  { key: 'folate', label: 'Folate' },
]

const MINERALS: RowSpec[] = [
  { key: 'calcium', label: 'Calcium' },
  { key: 'copper', label: 'Copper' },
  { key: 'iron', label: 'Iron' },
  { key: 'magnesium', label: 'Magnesium' },
  { key: 'manganese', label: 'Manganese' },
  { key: 'phosphorus', label: 'Phosphorus' },
  { key: 'potassium', label: 'Potassium' },
  { key: 'selenium', label: 'Selenium' },
  { key: 'sodium', label: 'Sodium' },
  { key: 'zinc', label: 'Zinc' },
]

const OTHER: RowSpec[] = [
  { key: 'water', label: 'Water' },
  { key: 'ash', label: 'Ash' },
  { key: 'caffeine', label: 'Caffeine' },
  { key: 'alcohol', label: 'Alcohol' },
  { key: 'sugar_alcohol', label: 'Sugar alcohols' },
]

/**
 * The complete facts layout, in reading order. `protein` itself opens the
 * Protein group; the eighteen amino acids are its collapsed disclosure.
 */
export const NUTRITION_GROUPS: {
  id: string
  title: string
  collapsedByDefault: boolean
  specs: RowSpec[]
}[] = [
  { id: 'carbohydrates', title: 'Carbohydrates', collapsedByDefault: false, specs: MACROS },
  { id: 'sugars', title: 'Sugars', collapsedByDefault: true, specs: SUGARS },
  { id: 'fat', title: 'Fats', collapsedByDefault: false, specs: FATS },
  { id: 'protein', title: 'Protein', collapsedByDefault: false, specs: [{ key: 'protein', label: 'Protein' }] },
  { id: 'amino-acids', title: 'Amino acids', collapsedByDefault: true, specs: AMINO_ACIDS },
  { id: 'vitamins', title: 'Vitamins', collapsedByDefault: false, specs: VITAMINS },
  { id: 'minerals', title: 'Minerals', collapsedByDefault: false, specs: MINERALS },
  { id: 'other', title: 'Other', collapsedByDefault: true, specs: OTHER },
]

/** Every published key the layout knows about — the catalog contract. */
export const NUTRITION_KEYS: string[] = NUTRITION_GROUPS.flatMap((g) => g.specs.map((s) => s.key))

/** The headline energy row, shown above the donut. */
export const ENERGY_ROW: RowSpec = { key: 'energy', label: 'Energy' }

function num(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Project a doc's nutrition into the display groups, dropping absent keys. */
export function nutritionGroups(n: Nutrition | null | undefined): NutritionGroup[] {
  if (!n) return []
  return NUTRITION_GROUPS.map((group) => ({
    id: group.id,
    title: group.title,
    collapsedByDefault: group.collapsedByDefault,
    rows: group.specs
      .filter((spec) => typeof n[spec.key] === 'number')
      .map((spec) => ({ ...spec, unit: unitFor(spec.key), value: num(n[spec.key]) })),
  })).filter((group) => group.rows.length > 0)
}

/**
 * Display rounding, never a stored one. A trace nutrient under 10 keeps a
 * decimal (0.9 g reads as a real quantity); anything above rounds to whole
 * units, which is the precision a facts panel claims.
 */
export function formatNutritionValue(value: number, unit: NutritionUnit): string {
  const abs = Math.abs(value)
  if (unit === 'kcal') return String(Math.round(value))
  if (abs > 0 && abs < 10) return String(Math.round(value * 10) / 10)
  return String(Math.round(value))
}

/** `label` + value + unit, the three columns every facts row renders. */
export function formatNutritionRow(row: NutritionRow): { value: string; unit: string } {
  return { value: formatNutritionValue(row.value, row.unit), unit: row.unit }
}
