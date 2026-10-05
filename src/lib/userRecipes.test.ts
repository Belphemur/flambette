import { describe, expect, test } from 'bun:test'
import {
  NEW_BADGE_DAYS,
  USER_RECIPE_ID_BASE,
  daysSinceAdded,
  isNewUserRecipe,
  isUserRecipeId,
  userRecipeAddedAt,
} from './userRecipes'

/**
 * User recipes (ADR-0052 §4). Two independent facts, pinned apart on
 * purpose: AUTHORSHIP is permanent (the "New" source bucket keeps
 * selecting the recipe forever) and RECENCY expires after
 * `NEW_BADGE_DAYS` (the NEW badge stops).
 *
 * The id band is the mechanism, so the boundary between "Mealime's" and
 * "ours" is pinned against the real catalog maximum as well as against
 * the constant.
 */

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000
const FIRST_USER_ID = USER_RECIPE_ID_BASE + 1

function userMeta(addedAt: number | null, id = FIRST_USER_ID) {
  return { id, first_published_at: addedAt }
}

describe('isUserRecipeId', () => {
  test('the reserved band is unreachable by the frozen catalog', () => {
    // The highest Mealime variant id in builder_data.json. If a catalog
    // sync ever pushed past the band, the first user recipe would stop
    // being identifiable and this is the assertion that would say so.
    expect(40_919).toBeLessThan(USER_RECIPE_ID_BASE)
    expect(USER_RECIPE_ID_BASE).toBe(90_000_000)
  })

  test('accepts the first allocated id and rejects real catalog ids', () => {
    expect(isUserRecipeId(FIRST_USER_ID)).toBe(true)
    expect(isUserRecipeId(USER_RECIPE_ID_BASE + 9999)).toBe(true)
    expect(isUserRecipeId(17452)).toBe(false)
    expect(isUserRecipeId(0)).toBe(false)
    expect(isUserRecipeId(-1)).toBe(false)
  })

  test('refuses anything that is not a finite number', () => {
    // A null id reaching this function means a lookup table handed back
    // nothing; answering `true` would hide a real recipe, `false` would
    // render a broken card, and a throw would take the grid down.
    expect(isUserRecipeId(null)).toBe(false)
    expect(isUserRecipeId(undefined)).toBe(false)
    expect(isUserRecipeId(Number.NaN)).toBe(false)
    expect(isUserRecipeId(Number.POSITIVE_INFINITY)).toBe(false)
  })
})

describe('userRecipeAddedAt', () => {
  test('reads the authored addedAt for a user recipe', () => {
    expect(userRecipeAddedAt(userMeta(NOW))).toBe(NOW)
  })

  test('is null for a Mealime recipe even when it has a timestamp', () => {
    // first_published_at on a catalog recipe is MEALIME's publish date.
    // Reading it as an "added" date would put every catalog recipe inside
    // the NEW badge window after a sync.
    expect(userRecipeAddedAt({ id: 17452, first_published_at: NOW })).toBeNull()
  })

  test('is null when the timestamp is unusable', () => {
    expect(userRecipeAddedAt(userMeta(null))).toBeNull()
    expect(userRecipeAddedAt({ id: FIRST_USER_ID })).toBeNull()
    expect(userRecipeAddedAt(userMeta(Number.NaN))).toBeNull()
  })
})

describe('isNewUserRecipe', () => {
  test('a recipe added an hour ago is new', () => {
    expect(isNewUserRecipe(userMeta(NOW - 3_600_000), NOW)).toBe(true)
  })

  test('the 30-day boundary is exclusive: 29 days new, 30 days not', () => {
    expect(isNewUserRecipe(userMeta(NOW - 29 * DAY), NOW)).toBe(true)
    expect(isNewUserRecipe(userMeta(NOW - 30 * DAY), NOW)).toBe(false)
    expect(isNewUserRecipe(userMeta(NOW - 30 * DAY - 1), NOW)).toBe(false)
  })

  test('the boundary is the constant, not a literal in the test', () => {
    expect(NEW_BADGE_DAYS).toBe(30)
    expect(isNewUserRecipe(userMeta(NOW - (NEW_BADGE_DAYS - 1) * DAY), NOW)).toBe(true)
    expect(isNewUserRecipe(userMeta(NOW - NEW_BADGE_DAYS * DAY), NOW)).toBe(false)
  })

  test('a Mealime recipe is never new, however recent its timestamp', () => {
    expect(isNewUserRecipe({ id: 17452, first_published_at: NOW }, NOW)).toBe(false)
    expect(isNewUserRecipe({ id: 17452 }, NOW)).toBe(false)
  })

  test('a missing or future addedAt reads as new, not as ancient', () => {
    // A hand-edited artifact, or a device whose clock was wrong when the
    // file was written, must not silently strip the badge: `age >= 0`
    // keeps a future date inside the window instead of making it older
    // than 30 days by negative arithmetic.
    expect(isNewUserRecipe(userMeta(null), NOW)).toBe(true)
    expect(isNewUserRecipe(userMeta(NOW + 5 * DAY), NOW)).toBe(true)
  })

  test('a recipe added exactly now is new', () => {
    expect(isNewUserRecipe(userMeta(NOW), NOW)).toBe(true)
  })
})

describe('daysSinceAdded', () => {
  test('is null for a Mealime recipe and for a missing timestamp', () => {
    expect(daysSinceAdded({ id: 17452, first_published_at: NOW }, NOW)).toBeNull()
    expect(daysSinceAdded(userMeta(null), NOW)).toBeNull()
  })

  test('measures days, fractional allowed', () => {
    expect(daysSinceAdded(userMeta(NOW), NOW)).toBe(0)
    expect(daysSinceAdded(userMeta(NOW - 10 * DAY), NOW)).toBe(10)
    expect(daysSinceAdded(userMeta(NOW - DAY / 2), NOW)).toBe(0.5)
  })
})
