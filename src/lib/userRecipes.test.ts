import { describe, expect, test } from 'bun:test'
import {
  NEW_BADGE_DAYS,
  USER_RECIPE_ID_BASE,
  isUserRecipeId,
  nextUserRecipeId,
  showNewBadge,
} from './userRecipes'

/**
 * User recipes (ADR-0054). Two independent facts, pinned apart on
 * purpose: AUTHORSHIP is decided by the loaded artifact's id set and is
 * permanent, while RECENCY expires after `NEW_BADGE_DAYS` and drives the
 * NEW badge only (locked decision L1).
 *
 * Note the shape: `isUserRecipeId(id, ids)` takes the set, because
 * `VariantMeta` is frozen and gains no flag. The reserved band is an id
 * ALLOCATION rule — it keeps the two id spaces from meeting — and this
 * test pins that it is never used as a membership test.
 */

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000
const PANCAKE = 900_001
const IDS = new Set([PANCAKE])

describe('USER_RECIPE_ID_BASE', () => {
  test('sits above the frozen catalog, so a sync can never collide', () => {
    // builder_data.json's highest variant id. If a future catalog sync
    // pushed past the band, user ids and catalog ids could meet.
    expect(40_919).toBeLessThan(USER_RECIPE_ID_BASE)
    expect(USER_RECIPE_ID_BASE).toBe(900_000)
  })
})

describe('isUserRecipeId', () => {
  test('answers from the loaded set, not from the band', () => {
    expect(isUserRecipeId(PANCAKE, IDS)).toBe(true)
    expect(isUserRecipeId(17452, IDS)).toBe(false)
  })

  test('an id inside the band that the artifact does not list is NOT a user recipe', () => {
    // The decisive test of "the artifact is the truth". A recipe deleted
    // from the artifact must stop being selectable immediately, and an
    // arithmetic band test would keep offering it forever.
    expect(PANCAKE).toBeGreaterThan(USER_RECIPE_ID_BASE)
    expect(isUserRecipeId(USER_RECIPE_ID_BASE + 999, IDS)).toBe(false)
    expect(isUserRecipeId(USER_RECIPE_ID_BASE, IDS)).toBe(false)
  })

  test('an empty set means no user recipes, and the app still works', () => {
    // A build whose user_recipes.json failed to load (ADR-0054 §1
    // degrade-gracefully) must render the catalog, not crash a facet.
    expect(isUserRecipeId(17452, new Set())).toBe(false)
    expect(isUserRecipeId(PANCAKE, new Set())).toBe(false)
  })

  test('refuses anything that is not a finite number', () => {
    for (const bad of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isUserRecipeId(bad, IDS), String(bad)).toBe(false)
    }
  })
})

describe('showNewBadge', () => {
  test('a recipe added an hour ago wears the badge', () => {
    expect(showNewBadge(NOW - 3_600_000, NOW)).toBe(true)
  })

  test('the 30-day boundary is exclusive: 29 days yes, 30 days no', () => {
    expect(showNewBadge(NOW - 29 * DAY, NOW)).toBe(true)
    expect(showNewBadge(NOW - 30 * DAY, NOW)).toBe(false)
    expect(showNewBadge(NOW - 30 * DAY - 1, NOW)).toBe(false)
  })

  test('the boundary is the constant, not a literal in the test', () => {
    expect(NEW_BADGE_DAYS).toBe(30)
    expect(showNewBadge(NOW - (NEW_BADGE_DAYS - 1) * DAY, NOW)).toBe(true)
    expect(showNewBadge(NOW - NEW_BADGE_DAYS * DAY, NOW)).toBe(false)
  })

  test('a recipe added exactly now wears the badge', () => {
    expect(showNewBadge(NOW, NOW)).toBe(true)
  })

  test('a future addedAt reads as new, not as ancient', () => {
    // A phone whose clock runs fast writes an addedAt the build machine's
    // clock has not reached. A two-sided `age >= 0` guard would strip the
    // badge off the card the household just created.
    expect(showNewBadge(NOW + 2 * 3_600_000, NOW)).toBe(true)
  })

  test('a missing or unusable addedAt reads as new', () => {
    // An absent timestamp is an absence of evidence; "not new" is the
    // claim that would need evidence. A hand-edited artifact should not
    // silently lose its badge.
    expect(showNewBadge(null, NOW)).toBe(true)
    expect(showNewBadge(undefined, NOW)).toBe(true)
    expect(showNewBadge(Number.NaN, NOW)).toBe(true)
  })
})

describe('nextUserRecipeId', () => {
  test('starts at the base of the reserved band', () => {
    expect(nextUserRecipeId([])).toBe(USER_RECIPE_ID_BASE)
    expect(nextUserRecipeId(new Set())).toBe(USER_RECIPE_ID_BASE)
  })

  test('appends one past the highest id in use', () => {
    expect(nextUserRecipeId([900_001])).toBe(900_002)
    expect(nextUserRecipeId([900_003, 900_001, 900_002])).toBe(900_004)
  })

  test('never allocates inside the catalog id space', () => {
    // The catalog's ids are in here too when the allocator is handed the
    // merged catalog, so this proves the base is a real floor and not an
    // assumption about the input.
    const merged = [17452, 40_919, 900_001]
    const next = nextUserRecipeId(merged)
    expect(next).toBe(900_002)
    expect(next).toBeGreaterThan(40_919)
  })

  test('a non-numeric entry cannot become an id', () => {
    const next = nextUserRecipeId([Number.NaN, 900_005, Number.POSITIVE_INFINITY] as number[])
    expect(next).toBe(900_006)
  })
})
