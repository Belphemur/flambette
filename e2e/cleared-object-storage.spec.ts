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

/** The frozen-mango grocery line rendering quantity `qty` (the successor-path spec). */
function mangoLine(page: Page, qty: RegExp) {
  return page
    .getByTestId('grocery-row')
    .filter({ hasText: /mango/i })
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

test('a fully checked egg row STAYS hidden after rotating planned meal servings (row claims)', async ({
  page,
}) => {
  // Both planned at base 6: the unitless egg lines merge — "1" + "6" = 7.
  // Checking the merged line checks the group's ONLY line, so the clear
  // mints ROW claims (whole-ingredient) — the ingestion skip, not the
  // successor matcher. The successor path itself is pinned by the mango
  // spec below (an unchecked sibling keeps the claim a line claim).
  await openDetailAndPlan(page, RECIPE_A, 'Sesame Encrusted')
  await openDetailAndPlan(page, RECIPE_B, 'Gado-gado')
  await gotoTab(page, 'Grocery')
  await expect(page.locator('main label').first()).toBeVisible({ timeout: 10_000 })
  await expect(eggLine(page, /^7$/)).toHaveCount(1)

  // Clear the merged egg line: BOTH variants' own shares are claimed
  // (A: 1, B: 6 — the merged checked line is attributed per contributor).
  await checkAndClearEgg(page)
  await expect(eggLine(page, /^7$/)).toHaveCount(0)

  // Rotate B's servings 6 -> 7 (the plan-row stepper). The row claims
  // hide the egg row at ANY re-sum — the persisted basis no longer
  // matters, so no stale-string resurrection.
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

  // Remove B: its fresh departure drops B's claim with its plan entry;
  // A's ROW claim still hides A's own "1" share — the render is A's 1,
  // hidden by the row skip.
  await removeMealFromPlan(page, RECIPE_B)
  await gotoTab(page, 'Grocery')
  await expect(eggLine(page, /^1$/)).toHaveCount(0, { timeout: 10_000 })

  // Re-add B: the fresh plan entry carries no claim, and A's row claim
  // only skips A's OWN contribution — B's unclaimed "6" must be VISIBLE
  // (a row claim never hides another variant's share).
  await openDetailAndPlan(page, RECIPE_B, 'Gado-gado')
  await gotoTab(page, 'Grocery')
  await expect(eggLine(page, /^6$/)).toBeVisible({ timeout: 10_000 })
})

test('a LINE claim survives a servings rotation beside an unchecked sibling (successor path)', async ({
  page,
}) => {
  // 7100 ("Coconut Tropical Citrus Smoothie") takes frozen mango in ml
  // while 7733 ("Mango Lime Smoothie Bowl") takes it in cups — the two
  // unit identities stay SEPARATE lines, so checking one leaves the
  // other unchecked and the clear mints a LINE claim (the successor
  // matcher, not the row skip). No single catalog recipe renders one
  // ingredient in two units, so the sibling comes from a second meal.
  await openDetailAndPlan(page, 'Coconut Tropical Citrus Smoothie', 'Coconut Tropical')
  await openDetailAndPlan(page, 'Mango Lime Smoothie Bowl', 'Mango Lime')
  await gotoTab(page, 'Grocery')
  await expect(page.locator('main label').first()).toBeVisible({ timeout: 10_000 })
  await expect(mangoLine(page, /^720 ml$/)).toHaveCount(1)
  await expect(mangoLine(page, /^6 cups$/)).toHaveCount(1)

  // Clear ONLY the ml line: a line claim on (mango, ml). The qty badge is
  // a flex SIBLING of the row's label, so locate the ROW (not the label).
  const mlRow = mangoLine(page, /^720 ml$/)
  await mlRow.locator('input[type=checkbox]').click()
  await page.locator('[data-test=grocery-clear]').click()
  await expect(page.getByText(/Cleared 1 checked item — unchecked items remain/)).toBeVisible()
  await expect(mangoLine(page, /^720 ml$/)).toHaveCount(0)
  // The unchecked cups sibling SURVIVES the clear (line-granular).
  await expect(mangoLine(page, /^6 cups$/)).toHaveCount(1)

  // Rotate the ml meal's servings 6 -> 7: the ml line re-sums to 840 ml.
  // The successor is the claiming variant's own current render (the
  // shadow), so the re-summed line stays hidden — and the cups sibling
  // was never claimed, so it stays visible throughout.
  await gotoTab(page, 'Plan')
  await page
    .getByRole('button', { name: 'More servings of Coconut Tropical Citrus Smoothie' })
    .click()
  await gotoTab(page, 'Grocery')
  await expect(mangoLine(page, /^840 ml$/)).toHaveCount(0, { timeout: 10_000 })
  await expect(mangoLine(page, /^6 cups$/)).toHaveCount(1)
})
