import { expect, test, type Page } from '@playwright/test'
import {
  blockExternalRequests,
  gotoTab,
  openRecipeDetail,
  waitForCatalog,
} from './helpers'

/**
 * ADR-0094 object-JSON cleared-ingredient storage — the e2e half of the
 * regression proof, on the catalog's real unitless-egg collision.
 *
 * 9064 ("Sesame Encrusted Salmon…", egg 1, serves 6) and 10275
 * ("Gado-gado Salad Bowl…", eggs 6, serves 6) both render UNITLESS egg
 * lines, so cross-recipe they aggregate into one `egg||N` identity — the
 * exact case the string-key model could not express (persisted basis
 * rotates with servings; the derived identity swallows siblings).
 *
 * No catalog recipe has two egg lines in ONE meal, so the sibling case is
 * exercised across meals (clear A's egg line, then add B — B's egg line
 * must SURVIVE) and the serving-stale case by rotating a planned meal's
 * servings after the clear (the cleared line must STAY hidden).
 *
 * The container-twin and milk whitespace-collision cases are NOT
 * reproducible from baked data (no soy-sauce pkg line, no 1cup/1 cup milk
 * split in the 5375-recipe scan) — they are covered at unit level in
 * grocery.test.ts and backup.test.ts.
 */

test.beforeEach(async ({ page }) => {
  await blockExternalRequests(page)
  await page.goto('/recipes')
  await waitForCatalog(page)
})

/** Recipe A: "…Salmon…", egg 1, serves 6. */
const RECIPE_A = 'Sesame Encrusted Salmon'
/** Recipe B: "Gado-gado Salad Bowl…" — eggs 6, serves 6. */
const RECIPE_B = 'Gado-gado Salad Bowl'

async function openDetailAndPlan(page: Page, prefix: string, search: string): Promise<void> {
  await gotoTab(page, 'Recipes')
  await page.getByLabel('Search recipes or ingredients').fill(search)
  await openRecipeDetail(page, new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  await page.getByRole('dialog').getByRole('button', { name: /Add to plan|Update in plan/ }).click()
}

async function removeMealFromPlan(page: Page, prefix: string): Promise<void> {
  await gotoTab(page, 'Plan')
  const remove = new RegExp(`^Remove ${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
  await page.getByRole('button', { name: remove }).click()
}

/** The egg grocery line rendering quantity `qty` (the row carries name + qty badge). */
function eggLine(page: Page, qty: RegExp) {
  return page
    .getByTestId('grocery-row')
    .filter({ hasText: /egg/i })
    .filter({ has: page.getByTestId('grocery-qty').filter({ hasText: qty }) })
}

/** Check the egg line's checkbox and run the direct "Clear checked" action. */
async function checkAndClearEgg(page: Page): Promise<void> {
  const label = page
    .locator('main label')
    .filter({ hasText: /egg/i })
    .filter({ has: page.locator('input[type=checkbox]') })
    .first()
  await label.locator('input[type=checkbox]').click()
  await page.locator('[data-test=grocery-clear]').click()
  await expect(page.getByText(/Cleared 1 checked item — unchecked items remain/)).toBeVisible()
}

test('clearing one meal egg line does NOT hide a sibling meal egg line added later', async ({
  page,
}) => {
  // A planned alone: its egg line renders "1" (authored basis, serves 6).
  await openDetailAndPlan(page, RECIPE_A, 'Sesame Encrusted')
  await gotoTab(page, 'Grocery')
  await expect(page.locator('main label').first()).toBeVisible({ timeout: 10_000 })
  await expect(eggLine(page, /^1$/)).toHaveCount(1)

  // Clear the egg line — the object claim carries A's OWN share (1 at
  // clear-time factor 1).
  await checkAndClearEgg(page)
  await expect(eggLine(page, /^1$/)).toHaveCount(0)

  // Now add B: its eggs render their own line "6" and must stay VISIBLE.
  // The identity model (pre-ADR-0094) would match A's persisted `egg||1`
  // against B's line by `egg||` identity and swallow it — the K5 sibling
  // swallow. The successor claim predicts "1", the render is "6": no
  // match, sibling survives.
  await openDetailAndPlan(page, RECIPE_B, 'Gado-gado')
  await gotoTab(page, 'Grocery')
  await expect(eggLine(page, /^6$/)).toBeVisible({ timeout: 10_000 })

  // A's cleared egg stays hidden beside it (only one egg line renders).
  await expect(eggLine(page, /^1$/)).toHaveCount(0)
})

test('a cleared egg line STAYS hidden after rotating a planned meal servings (serving-stale fixed)', async ({
  page,
}) => {
  // Both planned at base 6: the unitless egg lines merge — "1" + "6" = 7.
  await openDetailAndPlan(page, RECIPE_A, 'Sesame Encrusted')
  await openDetailAndPlan(page, RECIPE_B, 'Gado-gado')
  await gotoTab(page, 'Grocery')
  await expect(page.locator('main label').first()).toBeVisible({ timeout: 10_000 })
  await expect(eggLine(page, /^7$/)).toHaveCount(1)

  // Clear the merged egg line: BOTH variants' own shares are claimed
  // (A: 1, B: 6 — the merged checked line is attributed per contributor).
  await checkAndClearEgg(page)
  await expect(eggLine(page, /^7$/)).toHaveCount(0)

  // Rotate B's servings 6 -> 7 (the plan-row stepper). The render re-sums:
  // A 1 + B 6·(7/6) = 8. The successor claims re-derive with the SAME
  // math (A 1, B 7) and still hide the line — the persisted basis no
  // longer matters, so no stale-string resurrection.
  await gotoTab(page, 'Plan')
  await page.getByRole('button', { name: `More servings of ${RECIPE_B}` }).click()
  await gotoTab(page, 'Grocery')
  await expect(eggLine(page, /^8$/)).toHaveCount(0, { timeout: 10_000 })
  await expect(eggLine(page, /^7$/)).toHaveCount(0)
})

test('a cleared merged egg line stays hidden through plan composition changes', async ({
  page,
}) => {
  // Both planned, merged egg line "7", cleared as in the rotation test.
  await openDetailAndPlan(page, RECIPE_A, 'Sesame Encrusted')
  await openDetailAndPlan(page, RECIPE_B, 'Gado-gado')
  await gotoTab(page, 'Grocery')
  await expect(page.locator('main label').first()).toBeVisible({ timeout: 10_000 })
  await expect(eggLine(page, /^7$/)).toHaveCount(1)
  await checkAndClearEgg(page)
  await expect(eggLine(page, /^7$/)).toHaveCount(0)

  // Remove A: the render re-sums to B's own "6" — B's claim (6) still
  // accounts for it exactly, so the line stays hidden.
  await removeMealFromPlan(page, RECIPE_B)
  await gotoTab(page, 'Grocery')
  await expect(eggLine(page, /^6$/)).toHaveCount(0, { timeout: 10_000 })

  // Re-add A: the merged line is back to "7" (A 1 + B 6) — both claims
  // re-derive to the same successor, so it stays hidden there too.
  await openDetailAndPlan(page, RECIPE_A, 'Sesame Encrusted')
  await gotoTab(page, 'Grocery')
  await expect(eggLine(page, /^7$/)).toHaveCount(0, { timeout: 10_000 })
})
