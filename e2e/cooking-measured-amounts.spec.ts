import { expect, test, type Page } from '@playwright/test'
import {
  blockExternalRequests,
  expectZeroMealimeRequests,
  waitForCatalog,
} from './helpers'

/**
 * Phase 18 — measured amounts under the step text (ADR-0022): the "it
 * just says *a potato*" fix.
 *
 * A step detail line whose own quantity cannot be parsed gets a subdued
 * chip carrying the MEASURED quantity from `line_items`, scaled by the
 * current servings factor. Lines that already carry a parseable amount
 * get no chip, and nothing is ever invented.
 */

test.beforeEach(async ({ page }) => {
  await blockExternalRequests(page)
  await page.goto('/recipes')
  await waitForCatalog(page)
})

/** Deep-link to a recipe, bump servings, add it to the plan, start cooking. */
async function startCookingAt(page: Page, variantId: number, servings = 6) {
  await page.goto(`/recipe/${variantId}`)
  const sheet = page.getByRole('dialog')
  await expect(sheet).toBeVisible({ timeout: 15_000 })
  for (let i = 6; i < servings; i++) {
    await sheet.getByRole('button', { name: 'More servings' }).click()
  }
  await sheet.getByRole('button', { name: /Add to plan|Update in plan/ }).click()
  await sheet.getByRole('button', { name: 'Start cooking' }).click()
  const cooking = page.getByRole('dialog', { name: /Cooking / })
  await expect(cooking).toBeVisible()
  return cooking
}

/**
 * Grilled Chicken Caesar Wrap with Grape Tomatoes (6 servings, 11 steps).
 * Step 2's detail list says "zest and juice from 1 ½ lemon" and
 * "juice of ¾ lemon": both are imprecise as *quantities*, while the
 * line_items say `3 lemons`.
 */
const LEMON_WRAP = 5132

test('an imprecise step line gets a measured chip, scaled with the servings', async ({ page }) => {
  const cooking = await startCookingAt(page, LEMON_WRAP)

  // Step 1 has no imprecise ingredient line → no disclosure at all.
  await expect(cooking.getByTestId('measured-amounts')).toHaveCount(0)

  await cooking.getByRole('button', { name: /Next/ }).click()
  await expect(cooking.getByText('zest and juice from 1 ½ lemon')).toBeVisible()

  // Collapsed by default; opening it reveals the measured quantity.
  const disclosure = cooking.getByTestId('measured-amounts')
  await expect(disclosure).toBeVisible()
  const toggle = disclosure.getByTestId('measured-toggle')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(disclosure.getByTestId('measured-chip')).toHaveCount(0)

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  const chips = disclosure.getByTestId('measured-chip')
  // One chip per imprecise ingredient line, in step order.
  await expect(chips).toHaveCount(1)
  await expect(chips.first()).toHaveText('measured: 3 lemons')

  // The dressing step carries the same style of imprecise line. (The
  // disclosure stays open across step navigation — one toggle per session.)
  for (let i = 0; i < 4; i++) await cooking.getByRole('button', { name: /Next/ }).click()
  await expect(cooking.getByText('juice of ¾ lemon')).toBeVisible()
  await expect(cooking.getByTestId('measured-toggle')).toHaveAttribute('aria-expanded', 'true')
  await expect(cooking.getByTestId('measured-chip')).toHaveCount(1)
  await expect(cooking.getByTestId('measured-chip')).toHaveText('measured: 3 lemons')
  await expectZeroMealimeRequests(page)
})

test('measured chips scale with the planned servings', async ({ page }) => {
  // Same recipe at 12 servings: the 3 lemons double.
  const cooking = await startCookingAt(page, LEMON_WRAP, 12)
  await cooking.getByRole('button', { name: /Next/ }).click()
  const disclosure = cooking.getByTestId('measured-amounts')
  await expect(disclosure).toBeVisible()
  await disclosure.getByTestId('measured-toggle').click()
  await expect(disclosure.getByTestId('measured-chip').first()).toHaveText('measured: 6 lemons')
  await expectZeroMealimeRequests(page)
})

test('a recipe whose steps all carry parseable amounts shows no chips', async ({ page }) => {
  // Vegetarian Burrito Bowl: every detail line starts with a real amount
  // ("¾ (227 g) block cheddar cheese", "1 ½ (213 ml) cans tomato sauce").
  const cooking = await startCookingAt(page, 11481)
  const total = Number((await cooking.getByText(/Step 1 \/ (\d+)/).textContent())!.match(/(\d+)/)![1])
  for (let i = 0; i < total; i++) {
    await expect(cooking.getByTestId('measured-amounts')).toHaveCount(0)
    const next = cooking.getByRole('button', { name: /Next/ })
    if (await next.isEnabled()) await next.click()
  }
  await expectZeroMealimeRequests(page)
})
