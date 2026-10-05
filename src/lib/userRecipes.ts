/**
 * User recipes (ADR-0052) — the two facts every surface needs about a
 * recipe the household authored, as PURE functions with no catalog in
 * hand.
 *
 * A user recipe is a catalog entry: its `meta` is merged into
 * `variant_meta` at load, so search, diets, Auto-Plan, the grocery
 * derivation and the cooking view all treat it as a peer of a Mealime
 * recipe with no per-engine code. That is the point of the merge, and it
 * is also why these two questions must be answerable from a `VariantMeta`
 * ALONE — a component holding one card has no lookup table.
 *
 * Hence the reserved id band instead of a Set of ids: the highest
 * Mealime variant id is 40,919, and `scripts/user_recipes.py` allocates
 * user ids from `USER_RECIPE_ID_BASE`. "Is this ours?" is then
 * arithmetic (`id >= 90_000_000`), which is testable, stable across a
 * catalog sync, and impossible to get wrong by forgetting to register a
 * new id somewhere.
 *
 * The two facts are deliberately NOT the same fact:
 *   - AUTHORSHIP is permanent. A recipe added in March is still a user
 *     recipe in November, so the source filter's "New" bucket keeps
 *     selecting it forever (ADR-0052 §4, locked decision L1).
 *   - RECENCY expires. The NEW badge is a claim about when it was added,
 *     and after `NEW_BADGE_DAYS` it stops making that claim.
 * Collapsing them is the mistake this module exists to prevent: a filter
 * that empties itself after 30 days is a bug, and a badge that never
 * expires is a lie.
 */

/**
 * First id of the reserved band for user-authored recipes. Mealime's
 * catalog tops out at 40,919, so nothing a catalog sync can add reaches
 * this. Ids are allocated in ascending order from here.
 */
export const USER_RECIPE_ID_BASE = 90_000_000

/**
 * How long a user recipe keeps its NEW badge. A MONTH, not a year and
 * not forever: long enough that "I added this last week and forgot" is
 * covered, short enough that the badge keeps meaning something on a
 * catalog the household keeps growing.
 */
export const NEW_BADGE_DAYS = 30

const MS_PER_DAY = 24 * 60 * 60 * 1000

/** True when `id` is in the reserved user-recipe band. */
export function isUserRecipeId(id: number | null | undefined): boolean {
  return typeof id === 'number' && Number.isFinite(id) && id >= USER_RECIPE_ID_BASE
}

/**
 * The epoch milliseconds a user recipe was added, or null when this is a
 * Mealime recipe. `first_published_at` is the authored `addedAt`: it is
 * the only timestamp on a user recipe that means "the household added
 * this", and the catalog has no other field that could carry it.
 */
export function userRecipeAddedAt(meta: {
  id: number
  first_published_at?: number | null
}): number | null {
  if (!isUserRecipeId(meta.id)) return null
  const at = meta.first_published_at
  return typeof at === 'number' && Number.isFinite(at) ? at : null
}

/**
 * True while a user recipe should still wear its NEW badge — i.e. it was
 * added less than `NEW_BADGE_DAYS` ago.
 *
 * `now` is a PARAMETER, not `Date.now()`: the boundary (exactly 30 days)
 * is the interesting case, and a clock the test cannot set cannot pin it.
 *
 * A user recipe with no usable `addedAt` (a hand-edited artifact, a
 * device whose clock was wrong when it was written) is treated as NEW
 * rather than as never-new: an absent timestamp is an absence of
 * evidence, and hiding the badge would be the more surprising reading.
 * A timestamp in the FUTURE is the same case, and it is the COMMON one:
 * a phone whose clock runs two hours fast writes an `addedAt` the server
 * clock has not reached yet, and `age >= 0` would strip the badge off
 * the card the household just created. So the test is one-sided —
 * "older than 30 days" — and a negative age is a young recipe, not an
 * impossible one.
 */
export function isNewUserRecipe(
  meta: { id: number; first_published_at?: number | null },
  now: number = Date.now(),
): boolean {
  // The band check comes FIRST and owns the "unknown timestamp" fallback:
  // a Mealime recipe with no `addedAt` is not a new user recipe, it is a
  // catalog recipe, and the tolerant timestamp handling below must not be
  // able to say otherwise.
  if (!isUserRecipeId(meta.id)) return false
  const addedAt = userRecipeAddedAt(meta)
  if (addedAt === null) return true
  return now - addedAt < NEW_BADGE_DAYS * MS_PER_DAY
}

/** Days since a user recipe was added, or null when that is unknowable. */
export function daysSinceAdded(
  meta: { id: number; first_published_at?: number | null },
  now: number = Date.now(),
): number | null {
  const addedAt = userRecipeAddedAt(meta)
  if (addedAt === null) return null
  return (now - addedAt) / MS_PER_DAY
}
