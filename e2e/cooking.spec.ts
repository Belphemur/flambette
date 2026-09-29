import { expect, test } from '@playwright/test'
import { blockExternalRequests, openFirstRecipeDetail, waitForCatalog } from './helpers'

test.beforeEach(async ({ page }) => {
  await blockExternalRequests(page)
  await page.goto('/')
  await waitForCatalog(page)
})

/** Open the first recipe and enter cooking mode. Returns the cooking dialog.
 *  Cooking is plan-driven, so the recipe is added to the plan first. */
async function startCooking(page: import('@playwright/test').Page) {
  await openFirstRecipeDetail(page)
  const sheet = page.getByRole('dialog')
  await sheet.getByRole('button', { name: /Add to plan|Update in plan/ }).click()
  await sheet.getByRole('button', { name: 'Start cooking' }).click()
  const cooking = page.getByRole('dialog', { name: /Cooking / })
  await expect(cooking).toBeVisible()
  return cooking
}

test('cooking mode shows one step at a time with progress', async ({ page }) => {
  const cooking = await startCooking(page)

  // Step 1 content visible with progress "1 / N"
  await expect(cooking.getByText(/Step 1 \/ \d+/)).toBeVisible()
  await expect(cooking.getByText('Wash and dry the fresh produce.')).toBeVisible()
  // Step details render as a checklist sub-list
  await expect(cooking.getByText('6 medium carrots')).toBeVisible()
  // Previous is disabled on the first step
  await expect(cooking.getByRole('button', { name: /Previous/ })).toBeDisabled()
})

test('Next advances, progress updates, arrow keys work', async ({ page }) => {
  const cooking = await startCooking(page)

  await cooking.getByRole('button', { name: /Next/ }).click()
  await expect(cooking.getByText(/Step 2 \/ \d+/)).toBeVisible()
  await expect(cooking.getByText(/Trim off the ends and peel the carrots/)).toBeVisible()
  await expect(cooking.getByRole('button', { name: /Previous/ })).toBeEnabled()

  // Keyboard navigation
  await page.keyboard.press('ArrowRight')
  await expect(cooking.getByText(/Step 3 \/ \d+/)).toBeVisible()
  await expect(cooking.getByText(/Preheat a medium saucepan/)).toBeVisible()
  await page.keyboard.press('ArrowLeft')
  await expect(cooking.getByText(/Step 2 \/ \d+/)).toBeVisible()
})

test('Finish on the last step closes cooking mode', async ({ page }) => {
  const cooking = await startCooking(page)
  const progress = await cooking.getByText(/Step 1 \/ (\d+)/).textContent()
  const total = Number(progress!.match(/Step 1 \/ (\d+)/)![1])

  // Advance to the last step
  const next = cooking.getByRole('button', { name: /Next/ })
  for (let i = 1; i < total; i++) await next.click()
  await expect(cooking.getByText(new RegExp(`Step ${total} \\/ ${total}`))).toBeVisible()

  const finish = cooking.getByRole('button', { name: /Finish/ })
  await expect(finish).toBeVisible()
  await finish.click()
  await expect(cooking).not.toBeVisible()
  await expect(page.getByText('Enjoy!')).toBeVisible()
})

test('cooking position is not persisted across a reload', async ({ page }) => {
  const cooking = await startCooking(page)
  await cooking.getByRole('button', { name: /Next/ }).click()
  await expect(cooking.getByText(/Step 2 \/ \d+/)).toBeVisible()

  // The route (and plan membership) survive the reload; the step position
  // resets to the first step.
  await page.reload()
  const reopened = page.getByRole('dialog', { name: /Cooking / })
  await expect(reopened).toBeVisible({ timeout: 15_000 })
  await expect(reopened.getByText(/Step 1 \/ \d+/)).toBeVisible()
})
