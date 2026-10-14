/**
 * Pantry ingredient matching (ADR-0087 "Cook with what I have").
 *
 * THE one place that computes, given a pantry (a set of ingredient
 * nameKeys — the same merge key grocery aggregation uses, ADR-0012) and a
 * recipe's `variant_meta.ingredient_names`:
 *
 *  - the per-recipe data shape {have, total, missing[], ready} that the
 *    card badge renders from (ADR-0087 Decision 6),
 *  - the ≥1-overlap filter predicate (Decision 4),
 *  - the missing-ASCENDING comparator (Decision 4) that callers compose
 *    with their own sort comparator (ties fall through — this module
 *    never duplicates a sort funnel; see RecipesTab's getSortComparator).
 *
 * Pure and Vue-free: `RecipesTab` (ranking + summary counts) and
 * `RecipeCard` (badge) both consume this lib so the two can never drift
 * (DRY over SOLID over KISS, per the ADR).
 */
import { nameKey } from './grocery'
import type { VariantMeta } from './types'

/** Per-recipe pantry match, derived only from real data (ADR-0087 §6). */
export interface PantryMatch {
  /** Pantry ingredients this recipe also uses. */
  have: number
  /** Size of the pantry itself (the M in "You have N of M"). */
  total: number
  /**
   * The pantry keys this recipe does NOT use, in the pantry's own
   * insertion order (the same order the chip row shows) — so the badge's
   * "Needs 1 more: …" names a deterministic first missing ingredient.
   * Entries are nameKeys; the card resolves display names through the
   * pantry store (the one place that keeps what the user typed).
   */
  missing: string[]
  /** true when nothing is missing (the "Ready (N of N)" state). */
  ready: boolean
}

/** Key one ingredient name into pantry identity (the ONE nameKey rule). */
export function pantryKeyOf(name: string): string {
  return nameKey(name)
}

/**
 * The ONE per-recipe computation. An empty pantry yields the inactive
 * shape (have 0, total 0, no missing) — callers treat an empty pantry as
 * "feature off" and never render from it, but the shape stays total so
 * nothing downstream needs an extra guard.
 */
export function pantryMatch(
  ingredientNames: readonly string[],
  pantryKeys: ReadonlySet<string>,
): PantryMatch {
  const total = pantryKeys.size
  const used = new Set<string>()
  let have = 0
  for (const name of ingredientNames) {
    const key = nameKey(name)
    if (pantryKeys.has(key) && !used.has(key)) {
      used.add(key)
      have++
    }
  }
  const missing: string[] = []
  for (const key of pantryKeys) if (!used.has(key)) missing.push(key)
  return { have, total, missing, ready: total > 0 && missing.length === 0 }
}

/**
 * The ≥1-overlap filter (ADR-0087 Decision 4): with a non-empty pantry a
 * recipe stays in the grid only when it shares at least one pantry
 * ingredient. An empty pantry matches nothing — callers must keep the
 * grid on its normal browse path when the row is inactive, never call
 * this.
 */
export function sharesPantryIngredient(
  ingredientNames: readonly string[],
  pantryKeys: ReadonlySet<string>,
): boolean {
  if (pantryKeys.size === 0) return false
  for (const name of ingredientNames) {
    if (pantryKeys.has(nameKey(name))) return true
  }
  return false
}

/**
 * How many pantry ingredients this recipe does NOT use — the ranking
 * key. Fewer missing ranks first.
 */
export function missingCount(
  ingredientNames: readonly string[],
  pantryKeys: ReadonlySet<string>,
): number {
  return pantryMatch(ingredientNames, pantryKeys).missing.length
}

/**
 * The missing-ascending comparator (ADR-0087 Decision 4). Ties resolve
 * to 0 — the CALLER composes its own comparator after it
 * (`byMissing(a, b) || getSortComparator(sortBy)(a, b)`), so the sort
 * funnel stays single-source and this module stays sort-agnostic.
 */
export function compareByMissingCount(
  pantryKeys: ReadonlySet<string>,
): (a: VariantMeta, b: VariantMeta) => number {
  return (a, b) => missingCount(a.ingredient_names, pantryKeys) - missingCount(b.ingredient_names, pantryKeys)
}
