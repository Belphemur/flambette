import { expect, test } from '@playwright/test'
import {
  blockExternalRequests,
  expectZeroMealimeRequests,
  gotoTab,
  openFirstRecipeDetail,
  openRecipeDetail,
  waitForCatalog,
} from './helpers'

test.beforeEach(async ({ page }) => {
  await blockExternalRequests(page)
  await page.goto('/')
  await waitForCatalog(page)
})

/**
 * Enter cooking mode from the first recipe's detail sheet, WITHOUT planning
 * it first: any catalog recipe is cookable (ADR-0034). Returns the cooking
 * dialog and the recipe name.
 */
async function startCooking(page: import('@playwright/test').Page) {
  const name = await openFirstRecipeDetail(page)
  const sheet = page.getByRole('dialog')
  await sheet.getByRole('button', { name: 'Start cooking' }).click()
  const cooking = page.getByRole('dialog', { name: /Cooking / })
  await expect(cooking).toBeVisible()
  return { cooking, name }
}

/** As above, but the recipe is in the plan — the meal the Finish button
 *  takes out of it. */
async function startCookingPlanned(page: import('@playwright/test').Page) {
  const name = await openFirstRecipeDetail(page)
  const sheet = page.getByRole('dialog')
  await sheet.getByRole('button', { name: /Add to plan|Update in plan/ }).click()
  await sheet.getByRole('button', { name: 'Start cooking' }).click()
  const cooking = page.getByRole('dialog', { name: /Cooking / })
  await expect(cooking).toBeVisible()
  return { cooking, name }
}

/** Walk to the last step view. */
async function gotoLastStep(cooking: import('@playwright/test').Locator) {
  const progress = await cooking.getByText(/Step 1 \/ (\d+)/).textContent()
  const total = Number(progress!.match(/Step 1 \/ (\d+)/)![1])
  const next = cooking.getByRole('button', { name: /Next/ })
  for (let i = 1; i < total; i++) await next.click()
  await expect(cooking.getByText(new RegExp(`Step ${total} \\/ ${total}`))).toBeVisible()
  return total
}

test('cooking mode shows one step at a time with progress', async ({ page }) => {
  const { cooking } = await startCooking(page)

  // Step 1 content visible with progress "1 / N"
  await expect(cooking.getByText(/Step 1 \/ \d+/)).toBeVisible()
  await expect(cooking.getByText('Wash and dry the fresh produce.')).toBeVisible()
  // Step details render as a checklist sub-list
  await expect(cooking.getByText('6 medium carrots')).toBeVisible()
  // Previous is disabled on the first step
  await expect(cooking.getByRole('button', { name: /Previous/ })).toBeDisabled()
  await expectZeroMealimeRequests(page)
})

test('Next advances, progress updates, arrow keys work', async ({ page }) => {
  const { cooking } = await startCooking(page)

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
  await expectZeroMealimeRequests(page)
})

test('any recipe is cookable — Start cooking needs no plan (ADR-0034)', async ({ page }) => {
  // The plan is empty: cooking is no longer a plan-driven mode.
  await gotoTab(page, 'Plan')
  await expect(page.getByText('Your meal plan is empty')).toBeVisible()
  await gotoTab(page, 'Recipes')

  const { cooking, name } = await startCooking(page)
  await expect(cooking.getByTestId('step-counter')).toBeVisible()

  // An unplanned cook serves the recipe's OWN serving count.
  await expect(cooking.getByTestId('cook-serves')).toContainText('serves 6')
  expect(name).not.toBe('')
  await expectZeroMealimeRequests(page)
})

test('a deep link to an unplanned recipe opens cooking mode (ADR-0034)', async ({ page }) => {
  const name = await openFirstRecipeDetail(page)
  const id = new URL(page.url()).pathname.split('/').pop()
  await page.goto(`/cooking/${id}`)

  const cooking = page.getByRole('dialog', { name: /Cooking / })
  await expect(cooking).toBeVisible()
  await expect(cooking.getByText(/Step 1 \/ \d+/)).toBeVisible()
  // Servings fall back to the recipe's own, not to a plan entry.
  await expect(cooking.getByTestId('cook-serves')).toContainText('serves 6')
  expect(name).not.toBe('')
  await expectZeroMealimeRequests(page)
})

test('Finish on the last step records the cook and leaves cooking mode', async ({ page }) => {
  const { cooking, name } = await startCooking(page)
  await gotoLastStep(cooking)

  const finish = cooking.getByTestId('finish')
  await expect(finish).toBeVisible()
  // Finish is the ONLY mark on the last step: one action, one button.
  await expect(cooking.getByTestId('mark-cooked')).toHaveCount(0)
  await expect(finish).toContainText('Finish')
  await finish.click()
  await expect(cooking).not.toBeVisible()
  await expect(page.getByTestId('toast').getByText('Enjoy! Marked as cooked')).toBeVisible()

  // The cook was recorded — the recipe knows it has been cooked once.
  await gotoTab(page, 'History')
  await expect(page.getByTestId('history-row').first()).toContainText(name)
  await expectZeroMealimeRequests(page)
})

test('Finish takes a planned meal out of the plan, and Undo puts it back', async ({ page }) => {
  const { cooking, name } = await startCookingPlanned(page)
  // Cooking mode is a full-screen view; the tab bar is behind it.
  await page.keyboard.press('Escape')
  await expect(cooking).not.toBeVisible()
  await gotoTab(page, 'Plan')
  await expect(page.getByRole('button', { name: `Mark ${name} as cooked` })).toBeVisible()

  // Straight back into the cook — this leg is a deep link, which is how
  // a shared URL reaches an unfinished cook.
  const id = await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem('mealime-planner:v1:plan') ?? '{}')
    return stored.plan[0].variantId
  })
  await page.goto(`/cooking/${id}`)
  const reopened = page.getByRole('dialog', { name: /Cooking / })
  await expect(reopened).toBeVisible()
  await gotoLastStep(reopened)
  await reopened.getByTestId('finish').click()
  await expect(reopened).not.toBeVisible()

  // One action: the cook event is recorded AND the meal left the plan.
  await gotoTab(page, 'Plan')
  await expect(page.getByText('Your meal plan is empty')).toBeVisible()

  // Undo restores the exact prior state: the meal is back in the plan…
  await page.getByTestId('cook-undo').click()
  await expect(page.getByRole('button', { name: `Mark ${name} as cooked` })).toBeVisible()
  // …and the cook event is gone.
  await gotoTab(page, 'History')
  await expect(page.getByTestId('history-empty')).toBeVisible()
  await expectZeroMealimeRequests(page)
})

test('mark as cooked is available at EVERY step and keeps you cooking (ADR-0034)', async ({ page }) => {
  const { cooking, name } = await startCooking(page)

  // Reachable on the first step, not only at the end.
  const mark = cooking.getByTestId('mark-cooked')
  await expect(mark).toBeVisible()
  await mark.click()

  // Mid-cook marking records the cook and LEAVES YOU IN THE COOK.
  await expect(page.getByTestId('toast').getByText('Marked as cooked')).toBeVisible()
  await expect(cooking).toBeVisible()
  await expect(cooking.getByText(/Step 1 \/ \d+/)).toBeVisible()
  await expect(cooking.getByTestId('mark-cooked')).toBeDisabled()

  // A session records ONE cook: finishing after the mid-cook mark closes
  // without writing a second event (ADR-0034).
  await gotoLastStep(cooking)
  await cooking.getByTestId('finish').click()
  await expect(cooking).not.toBeVisible()
  await gotoTab(page, 'Recipes')
  await openRecipeDetail(page, name)
  await expect(page.getByTestId('cook-history')).toContainText('Cooked 1 time')

  // Undo takes the cook back.
  await page.getByTestId('cook-undo').click()
  await page.keyboard.press('Escape')
  await expect(cooking).not.toBeVisible()
  await gotoTab(page, 'History')
  await expect(page.getByTestId('history-empty')).toBeVisible()
  await gotoTab(page, 'Recipes')
  await openRecipeDetail(page, name)
  await expect(page.getByTestId('cook-history')).toHaveCount(0)
  await expectZeroMealimeRequests(page)
})
test('cooking position is not persisted across a reload', async ({ page }) => {
  const { cooking } = await startCooking(page)
  await cooking.getByRole('button', { name: /Next/ }).click()
  await expect(cooking.getByText(/Step 2 \/ \d+/)).toBeVisible()

  // The route survives the reload; the step position resets to step 1.
  await page.reload()
  const reopened = page.getByRole('dialog', { name: /Cooking / })
  await expect(reopened).toBeVisible({ timeout: 15_000 })
  await expect(reopened.getByText(/Step 1 \/ \d+/)).toBeVisible()
  await expectZeroMealimeRequests(page)
})
