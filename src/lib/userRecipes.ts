/**
 * User recipes (ADR-0052) — the two facts every surface needs about a
 * recipe the household authored, as PURE functions.
 *
 * A user recipe is a catalog entry: its `meta` is merged into
 * `variant_meta` at load, so search, diet chips, the meal-type facet,
 * Auto-Plan, the grocery derivation, cooking, favourites, ratings and
 * the room payload all treat it as a peer of a Mealime recipe with no
 * per-engine code (locked decision L4). That is the point of the merge,
 * and it is also why "is this ours?" has to be answerable from a plain
 * id plus the loaded artifact — `VariantMeta` is FROZEN and gains no
 * `isUserRecipe` flag, so the id set the catalog builds is the only
 * available answer, and a component holding one card must be able to
 * ask for it without a catalog object.
 *
 * The two facts are deliberately NOT the same fact:
 *
 *   - AUTHORSHIP is permanent. A recipe added in March is still a user
 *     recipe in November, so the source filter's "New" bucket keeps
 *     selecting it forever (locked decision L1). Nothing expires it.
 *   - RECENCY expires. The NEW badge on the card is a claim about when
 *     the recipe was added, and after `NEW_BADGE_DAYS` it stops making
 *     that claim.
 *
 * Collapsing them is the mistake this module exists to prevent: a filter
 * that empties itself after 30 days is a bug (the brief's locked
 * decision), and a badge that never expires is a lie.
 */

/**
 * The lowest id the user-recipe band uses (ADR-0052 §1). The first
 * user recipe is allocated exactly this id, and `nextUserRecipeId`
 * climbs from there.
 *
 * A RESERVATION, not a test: the catalog's highest variant id is 40,919
 * and the brief asks for 900000+, so no catalog sync can ever allocate an
 * id in this band and collide with a user recipe. Membership is still
 * decided by the loaded id set — the band keeps the two id spaces from
 * ever MEETING, it does not decide who is a user recipe. That stays with
 * the artifact, because a stale id left in the band by a deleted recipe
 * must stop being selectable, and an arithmetic test would keep offering
 * it.
 */
export const USER_RECIPE_ID_BASE = 900_000

/**
 * How long a user recipe keeps its NEW badge. A MONTH, not a year and not
 * forever: long enough that "I added this last week and forgot" is
 * covered, short enough that the badge keeps meaning something on a
 * catalog the household keeps growing. Drives the BADGE only.
 */
export const NEW_BADGE_DAYS = 30

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * True when `id` is one of the loaded user-recipe ids — the artifact is
 * the only truth here (ADR-0052 §1), and an id that is merely inside the
 * reserved band is not a user recipe if the artifact does not say so.
 *
 * `ids` is a `ReadonlySet` so a caller can pass `catalog.userRecipeIds`
 * without a defensive copy, and so a test can pass a literal.
 */
export function isUserRecipeId(
  id: number | null | undefined,
  ids: ReadonlySet<number>,
): boolean {
  if (typeof id !== 'number' || !Number.isFinite(id)) return false
  return ids.has(id)
}

/**
 * True while a user recipe should still wear its NEW badge, i.e. it was
 * added less than `NEW_BADGE_DAYS` ago.
 *
 * `now` is a PARAMETER, not `Date.now()`: the boundary (exactly 30 days)
 * is the interesting case, and a clock the test cannot set cannot pin it.
 *
 * Two edge cases, both chosen so a card never lies in the direction of
 * hiding something the household just made:
 *
 *  - a FUTURE `addedAt` counts as new. A phone whose clock runs two
 *    hours fast writes a timestamp the build machine's clock has not
 *    reached, and a `age >= 0` guard would strip the badge off the card
 *    the household created minutes ago. The test is therefore
 *    one-sided — "older than 30 days" — and a negative age is a young
 *    recipe, not an impossible one.
 *  - a MISSING or unusable `addedAt` counts as new: an absent timestamp
 *    is an absence of evidence, and "not new" is the claim that would
 *    need evidence. A hand-edited artifact should not silently lose its
 *    badge.
 */
export function showNewBadge(addedAt: number | null | undefined, now: number = Date.now()): boolean {
  if (typeof addedAt !== 'number' || !Number.isFinite(addedAt)) return true
  return now - addedAt < NEW_BADGE_DAYS * MS_PER_DAY
}

/**
 * The next free id for a new user recipe: one past the highest id the
 * artifact already uses, never below the reserved base.
 *
 * Pure, so the allocator is unit-testable and the AUTHORING step (the
 * skill's procedure, and any future add-a-recipe UI) cannot invent a
 * colliding id. Ascending order also keeps a diff of the artifact
 * readable: new recipes append.
 */
export function nextUserRecipeId(existingIds: Iterable<number>): number {
  let highest = USER_RECIPE_ID_BASE - 1
  for (const id of existingIds) {
    if (typeof id === 'number' && Number.isFinite(id) && id > highest) highest = id
  }
  return highest + 1
}
