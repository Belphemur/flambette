/**
 * Pantry ingredient matching (ADR-0087 "Cook with what I have").
 *
 * THE one place that computes, given a pantry (a set of ingredient
 * nameKeys — the same merge key grocery aggregation uses, ADR-0012) and a
 * recipe's match surface — `variant_meta.ingredient_names` PLUS the
 * recipe name (ADR-0087 Addendum §1: no variant lists `cherry tomatoes`
 * under `ingredient_names`, yet many carry it in the name, so a pantry
 * key is "used" when it appears in `ingredient_names` OR its word tokens
 * occur as a contiguous, case-insensitive, nameKey-normalized sequence
 * in the recipe name):
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

/**
 * The per-recipe match surface: what a pantry is matched against. Both
 * fields come straight off `VariantMeta` — passing the meta itself (or
 * any object of this shape) keeps ONE call shape for every consumer
 * (RecipesTab's facet/rank, RecipeCard's badge) and for the unit pins.
 */
export interface PantryRecipeInput {
  name: string
  ingredient_names: readonly string[]
}

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
 * Word tokens of a phrase, each through the nameKey rule (case + English
 * plural folding). Punctuation is a word boundary, so a name's
 * "…Spinach, & Cherry Tomatoes" yields [..., 'cherry', 'tomato'].
 */
function phraseTokens(phrase: string): string[] {
  return phrase
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0)
    .map(nameKey)
}

/** Does `haystack` contain `needle`'s token sequence contiguously? */
function tokensContain(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || haystack.length < needle.length) return false
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return true
  }
  return false
}

/**
 * The pantry keys this recipe USES (Addendum §1): every key met on the
 * `ingredient_names` surface, plus every key whose word tokens occur as
 * a contiguous sequence in the recipe name. A key absent from BOTH
 * surfaces is a genuine "missing".
 */
function usedPantryKeys(
  recipe: PantryRecipeInput,
  pantryKeys: ReadonlySet<string>,
): Set<string> {
  const used = new Set<string>()
  for (const name of recipe.ingredient_names) {
    const key = nameKey(name)
    if (pantryKeys.has(key)) used.add(key)
  }
  if (used.size < pantryKeys.size) {
    const nameTokens = phraseTokens(recipe.name)
    for (const key of pantryKeys) {
      if (!used.has(key) && tokensContain(nameTokens, phraseTokens(key))) {
        used.add(key)
      }
    }
  }
  return used
}

/**
 * The ONE per-recipe computation. An empty pantry yields the inactive
 * shape (have 0, total 0, no missing) — callers treat an empty pantry as
 * "feature off" and never render from it, but the shape stays total so
 * nothing downstream needs an extra guard.
 */
export function pantryMatch(
  recipe: PantryRecipeInput,
  pantryKeys: ReadonlySet<string>,
): PantryMatch {
  const total = pantryKeys.size
  if (total === 0) return { have: 0, total: 0, missing: [], ready: false }
  const used = usedPantryKeys(recipe, pantryKeys)
  const missing: string[] = []
  for (const key of pantryKeys) if (!used.has(key)) missing.push(key)
  return { have: used.size, total, missing, ready: missing.length === 0 }
}

/**
 * The ≥1-overlap filter (ADR-0087 Decision 4): with a non-empty pantry a
 * recipe stays in the grid only when it shares at least one pantry
 * ingredient — on the full match surface (names + recipe name, Addendum
 * §1). An empty pantry matches nothing — callers must keep the grid on
 * its normal browse path when the row is inactive, never call this.
 */
export function sharesPantryIngredient(
  recipe: PantryRecipeInput,
  pantryKeys: ReadonlySet<string>,
): boolean {
  if (pantryKeys.size === 0) return false
  return usedPantryKeys(recipe, pantryKeys).size > 0
}

/**
 * How many pantry ingredients this recipe does NOT use — the ranking
 * key. Fewer missing ranks first.
 */
export function missingCount(
  recipe: PantryRecipeInput,
  pantryKeys: ReadonlySet<string>,
): number {
  return pantryMatch(recipe, pantryKeys).missing.length
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
  // VariantMeta carries both surface fields, so it IS a PantryRecipeInput.
  return (a, b) => missingCount(a, pantryKeys) - missingCount(b, pantryKeys)
}
