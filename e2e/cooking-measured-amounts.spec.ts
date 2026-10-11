import { expect, test, type Page } from '@playwright/test'
import {
  blockExternalRequests,
  expectZeroMealimeRequests,
  waitForCatalog,
} from './helpers'

/**
 * "This step uses" — the measured amounts of a step view as an
 * interactive checklist card (ADR-0081).
 *
 * The ADR-0022 derivation is UNCHANGED: a detail line whose own quantity
 * cannot be parsed gets a row carrying the MEASURED quantity from
 * `line_items`, scaled by the current servings factor. Lines that already
 * carry a parseable amount get no row, and nothing is ever invented.
 * What changed is the PRESENTATION (ADR-0081's supersession): the
 * collapsed chip became a full-row checkbox card, checked state is
 * ephemeral per-step view state.
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

test('an imprecise step line gets a checklist row, scaled with the servings', async ({ page }) => {
  const cooking = await startCookingAt(page, LEMON_WRAP)

  // Step 1 has no imprecise ingredient line → no card at all.
  await expect(cooking.getByTestId('measured-amounts')).toHaveCount(0)

  await cooking.getByRole('button', { name: /Next/ }).click()
  await expect(cooking.getByText('zest and juice from 1 ½ lemon')).toBeVisible()

  // The card is ALWAYS open (ADR-0081): there is no disclosure any more,
  // the rows are the surface.
  const card = cooking.getByTestId('measured-amounts')
  await expect(card).toBeVisible()
  await expect(card).toContainText('This step uses')
  await expect(card.getByTestId('measured-count')).toContainText('1 ingredient')
  // One row per imprecise ingredient line, in step order. The bold mono
  // amount and the ingredient name are separate spans of the SAME
  // derivation — never a re-parse of the label.
  const rows = card.getByTestId('measured-chip')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('lemons')
  await expect(rows.first()).toContainText('3')

  // The row is a REAL checkbox: role/checked state queryable.
  const check = rows.first().getByTestId('measured-check')
  await expect(check).not.toBeChecked()
  await rows.first().click()
  await expect(check).toBeChecked()
  // Checked = the success family, struck-through muted text (ADR-0072):
  // the class is the contract, asserted on the box element.
  const box = rows.first().locator('span').first()
  await expect(box).toHaveClass(/bg-success/)
  await expect(rows.first().locator('.line-through')).toHaveCount(2)

  // Unchecking restores the row.
  await rows.first().click()
  await expect(check).not.toBeChecked()
  await expect(box).not.toHaveClass(/bg-success/)
  await expect(rows.first().locator('.line-through')).toHaveCount(0)

  // The dressing step carries the same style of imprecise line, and
  // navigating there shows ITS row.
  for (let i = 0; i < 4; i++) await cooking.getByRole('button', { name: /Next/ }).click()
  await expect(cooking.getByText('juice of ¾ lemon')).toBeVisible()
  await expect(cooking.getByTestId('measured-chip')).toHaveCount(1)
  await expect(cooking.getByTestId('measured-chip')).toContainText('lemons')
  await expectZeroMealimeRequests(page)
})

test('checked state is EPHEMERAL per-step view state (ADR-0081)', async ({ page }) => {
  const cooking = await startCookingAt(page, LEMON_WRAP)
  await cooking.getByRole('button', { name: /Next/ }).click()
  const row = cooking.getByTestId('measured-chip').first()
  await row.click()
  await expect(row.getByTestId('measured-check')).toBeChecked()

  // Walking away and back resets the checklist: the chips were never
  // persisted and the checklist is a "did I add this yet" aid.
  await cooking.getByRole('button', { name: /Previous/ }).click()
  await cooking.getByRole('button', { name: /Next/ }).click()
  await expect(row.getByTestId('measured-check')).not.toBeChecked()
  await expectZeroMealimeRequests(page)
})

test('measured rows scale with the planned servings', async ({ page }) => {
  // Same recipe at 12 servings: the 3 lemons double.
  const cooking = await startCookingAt(page, LEMON_WRAP, 12)
  await cooking.getByRole('button', { name: /Next/ }).click()
  const card = cooking.getByTestId('measured-amounts')
  await expect(card).toBeVisible()
  await expect(card.getByTestId('measured-chip').first()).toContainText('6')
  await expect(card.getByTestId('measured-chip').first()).toContainText('lemons')
  await expectZeroMealimeRequests(page)
})

test('a recipe whose steps all carry parseable amounts shows no card', async ({ page }) => {
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
