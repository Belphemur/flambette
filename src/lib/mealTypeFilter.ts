/**
 * Meal-type filter (ADR-0043) — Breakfast / Dessert / Snack / Simple / Dinner.
 *
 * The taxonomy is the CATALOG'S OWN field, not a guess: every variant carries
 * `ruleset` (dinner | simple | breakfast | dessert | snack | cpg), the same
 * field the Mealime app filters on (its "151 breakfast recipes" is exactly this
 * field's count). So unlike ADR-0018's diet lens this filter is EXACT — no
 * keyword heuristic, no memo table, no suggestion.
 *
 * The COUNTS shown in the dropdown are tallied at build time by
 * scripts/extract_recipe_types.py into public/data/recipe_types.json, which
 * this module imports statically (Vite inlines it, the ingredients.json
 * precedent in ingredientSuggestions.ts). The client never scans 2,759 metas
 * just to paint a number.
 *
 * Ids are NEGATIVE so an occasion can never collide with a positive catalog
 * variant id. `cpg` (-6, Mealime's cost-per-gram product-placement bucket) is
 * counted for partition parity but never offered as a meal.
 */

import recipeTypesJson from '../../public/data/recipe_types.json'

export type MealTypeId = -1 | -2 | -3 | -4 | -5 | -6

/** One display row: the frozen registry + the build-time count. */
export interface MealTypeOption {
  id: MealTypeId
  label: string
  /** lucide-vue-next component name (bundled, ADR-0029). */
  icon: string
  /** The catalog's own `ruleset` value this option selects. */
  ruleset: string
  /** Build-time count from the committed recipe_types.json. */
  count: number
}

interface RecipeTypesDoc {
  byId: Record<
    string,
    { id: number; label: string; icon: string; ruleset: string; count: number; offered: boolean }
  >
  order: number[]
  total: number
  unmatched: number
}

const doc = recipeTypesJson as RecipeTypesDoc

/** Every bucket, in display order (Breakfast → Dinner, Branded last). */
export const MEAL_TYPE_OPTIONS: readonly MealTypeOption[] = doc.order.map((id) => {
  const row = doc.byId[String(id)]
  return { id: id as MealTypeId, label: row.label, icon: row.icon, ruleset: row.ruleset, count: row.count }
})

/** The buckets the dropdown offers — excludes `cpg`, which is not a meal. */
export const OFFERED_MEAL_TYPES: readonly MealTypeOption[] = MEAL_TYPE_OPTIONS.filter(
  (o) => doc.byId[String(o.id)].offered
)

export const MEAL_TYPE_IDS: readonly MealTypeId[] = OFFERED_MEAL_TYPES.map((o) => o.id)

/** id → the `ruleset` string it selects. Drives the facet, O(1). */
const RULESET_BY_ID = new Map<MealTypeId, string>(MEAL_TYPE_OPTIONS.map((o) => [o.id, o.ruleset]))

export function mealTypeLabel(id: MealTypeId | null): string {
  if (id === null) return 'Any'
  return MEAL_TYPE_OPTIONS.find((o) => o.id === id)?.label ?? 'Any'
}

/** Build-time count of a bucket (for the dropdown's "N" badge). */
export function mealTypeCount(id: MealTypeId): number {
  return MEAL_TYPE_OPTIONS.find((o) => o.id === id)?.count ?? 0
}

/**
 * Coerce an UNTRUSTED value (backup import, room snapshot) into a MealTypeId
 * or null. Unknown ids are dropped, never trusted — same rule as diets.
 */
export function normalizeMealType(value: unknown): MealTypeId | null {
  return MEAL_TYPE_IDS.includes(value as MealTypeId) ? (value as MealTypeId) : null
}

/**
 * The facet: does this variant belong to the selected bucket?
 * Exact string compare against the catalog's own `ruleset` — no scan, no
 * allocation, no heuristic.
 */
export function matchesMealType(ruleset: string | undefined, selected: MealTypeId | null): boolean {
  if (selected === null) return true
  const want = RULESET_BY_ID.get(selected)
  return want !== undefined && ruleset === want
}
