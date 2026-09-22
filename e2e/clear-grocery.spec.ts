import { expect, test, type Page } from '@playwright/test'
import {
  blockExternalRequests,
  gotoTab,
  openFirstRecipeDetail,
  waitForCatalog,
} from './helpers'

test.beforeEach(async ({ page }) => {
  await blockExternalRequests(page)
  await page.goto('/')
  await waitForCatalog(page)
})

/**
 * Phase 7: clear-grocery workflow + mark-as-cooked.
 *
 * The grocery list is derived from plan.plan + plan.customItems, with
 * checkbox state in the grocery store. "Clear" wipes ONLY the checkbox
 * map and the custom items — planned meals stay in the plan.
 */

/** Plan the first catalog recipe (returns its display name). */
async function planFirstRecipe(page: Page): Promise<string> {
  const name = await openFirstRecipeDetail(page)
  await page.getByRole('dialog').getByRole('button', { name: /Add to plan|Update in plan/ }).click()
  return name
}

/** Add a free-form grocery item from the Grocery tab form. */
async function addCustomItem(page: Page, text: string): Promise<void> {
  await page.getByLabel('Add a custom grocery item').fill(text)
  await page.getByRole('button', { name: 'Add', exact: true }).click()
}

/** The confirmation toast with its inline Clear / Cancel buttons. */
function confirmToast(page: Page) {
  return page.locator('[data-test=toast]')
}

/**
 * Check every grocery checkbox (recipe lines + custom items) by repeatedly
 * clicking the first unchecked one. Checked rows stay in place on the
 * Grocery tab, so the unchecked pool shrinks monotonically.
 */
async function checkAllGroceryItems(page: Page): Promise<void> {
  for (let guard = 0; guard < 60; guard++) {
    const unchecked = page.locator('main input[type=checkbox]:not(:checked)')
    if ((await unchecked.count()) === 0) return
    await unchecked.first().click()
  }
  throw new Error('could not check every grocery item')
}

test('checking the last item prompts to clear; Cancel aborts, then Clear works', async ({
  page,
}) => {
  await planFirstRecipe(page)
  await gotoTab(page, 'Grocery')
  await addCustomItem(page, 'Olive oil')
  const total = Number(
    (await page.getByText(/(\d+) \/ (\d+) items/).textContent())!.match(/(\d+) \/ (\d+)/)![2],
  )
  expect(total).toBeGreaterThan(1) // recipe lines + the custom item

  await checkAllGroceryItems(page)
  await expect(page.getByText(/(\d+) \/ (\d+) items/)).toHaveText(`${total} / ${total} items`)

  // Non-blocking confirmation with Clear / Cancel — not window.confirm.
  const toast = confirmToast(page)
  await expect(toast).toContainText('All items checked — clear the list?')
  await expect(toast.locator('[data-test=toast-action-secondary]')).toContainText('Cancel')

  // Cancel aborts: toast gone, state untouched.
  await toast.locator('[data-test=toast-action-secondary]').click()
  await expect(toast).toHaveCount(0)
  await expect(page.getByText(/(\d+) \/ (\d+) items/)).toHaveText(`${total} / ${total} items`)
  await expect(page.locator('[data-test=custom-items] li')).toHaveCount(1)

  // Re-trigger (uncheck one, check it again) and confirm this time.
  await page.locator('main input[type=checkbox]:checked').first().click()
  await page.locator('main input[type=checkbox]:not(:checked)').first().click()
  await expect(toast).toContainText('All items checked — clear the list?')
  await toast.locator('[data-test=toast-action-primary]').click()

  // Checkbox map wiped + custom items emptied; feedback toast shows.
  // Planned meals stay, so the derived list rebuilds: recipe lines are
  // back (unchecked), only the custom item is gone.
  await expect(page.getByText(/(\d+) \/ (\d+) items/)).toHaveText(`0 / ${total - 1} items`)
  await expect(page.locator('[data-test=custom-items]')).toHaveCount(0)
  await expect(page.getByText('Grocery list cleared')).toBeVisible()
})

test('the Clear-list button works from the Grocery tab', async ({ page }) => {
  await planFirstRecipe(page)
  await gotoTab(page, 'Grocery')

  // Hidden while nothing is checked.
  await expect(page.locator('[data-test=clear-list]')).toHaveCount(0)
  await page.locator('main input[type=checkbox]').first().click()
  const total = Number(
    (await page.getByText(/(\d+) \/ (\d+) items/).textContent())!.match(/(\d+) \/ (\d+)/)![2],
  )
  await expect(page.locator('[data-test=clear-list]')).toBeVisible()

  await page.locator('[data-test=clear-list]').click()
  const toast = confirmToast(page)
  await expect(toast).toContainText('Clear the grocery list?')
  await toast.locator('[data-test=toast-action-primary]').click()
  // Map wiped: unchecked again. Planned meals stay, so the list rebuilds.
  await expect(page.getByText(/(\d+) \/ (\d+) items/)).toHaveText(`0 / ${total} items`)
  await expect(page.locator('[data-test=clear-list]')).toHaveCount(0)
})

test('the Clear-list button works from shopping mode', async ({ page }) => {
  await planFirstRecipe(page)
  await gotoTab(page, 'Grocery')
  await page.locator('[data-test=start-shopping]').click()
  await expect(page).toHaveURL(/\/shop$/)

  // Hidden while nothing is checked.
  await expect(page.locator('[data-test=clear-list]')).toHaveCount(0)
  await page.locator('[data-test=shop-row]').first().click()
  await expect(page.locator('[data-test=clear-list]')).toBeVisible()

  await page.locator('[data-test=clear-list]').click()
  const toast = confirmToast(page)
  await expect(toast).toContainText('Clear the grocery list?')
  await toast.locator('[data-test=toast-action-primary]').click()
  // Map wiped (rows undimmed again); planned meals stay, so the derived
  // list rebuilds — the shop empty-state is NOT expected here.
  await expect(page.locator('[data-test=shopping-progress]')).toHaveText(/^0 \/ \d+$/)
  await expect(page.locator('[data-test=shop-row]:not(.opacity-40)').first()).toBeVisible()
  await expect(page.getByText('Grocery list cleared')).toBeVisible()
})

test('clearing removes custom items but keeps the planned meals', async ({ page }) => {
  const meal = await planFirstRecipe(page)
  await gotoTab(page, 'Grocery')
  await addCustomItem(page, 'Olive oil')
  await checkAllGroceryItems(page)
  const toast = confirmToast(page)
  await expect(toast).toContainText('All items checked — clear the list?')
  await toast.locator('[data-test=toast-action-primary]').click()

  // Grocery side: checkbox map + custom items gone. Planned meals stay,
  // so their ingredient lines rebuild (unchecked); the form is back.
  await expect(page.getByText(/(\d+) \/ (\d+) items/)).toHaveText(new RegExp(`^0 \/ \\d+ items\\s*$`))
  await expect(page.locator('[data-test=custom-items]')).toHaveCount(0)
  await expect(page.getByLabel('Add a custom grocery item')).toBeVisible()
  await expect(page.locator('main label').filter({ hasText: /cloves|carrot/i }).first()).toBeVisible()

  // The Plan tab still lists the planned meal.
  await gotoTab(page, 'Plan')
  await expect(page.getByRole('heading', { name: meal })).toBeVisible()
})

test('the full empty state reappears after clearing a custom-only list', async ({ page }) => {
  await gotoTab(page, 'Grocery')
  await addCustomItem(page, 'Olive oil')
  await addCustomItem(page, 'Paper towels')

  await checkAllGroceryItems(page)
  const toast = confirmToast(page)
  await expect(toast).toContainText('All items checked — clear the list?')
  await toast.locator('[data-test=toast-action-primary]').click()

  // Nothing planned + nothing custom → the "Nothing to buy yet" empty state.
  await expect(page.getByText('Nothing to buy yet')).toBeVisible()
  await expect(page.locator('[data-test=add-item-form]')).toBeVisible()
})

test('marking a planned meal cooked removes it and its grocery lines', async ({ page }) => {
  const meal = await planFirstRecipe(page)

  // Its ingredients are on the grocery list first…
  await gotoTab(page, 'Grocery')
  await expect(page.locator('main label').first()).toBeVisible({ timeout: 10_000 })

  // …then the meal is cooked from the Plan tab row.
  await gotoTab(page, 'Plan')
  await page.getByRole('button', { name: `Mark ${meal} as cooked` }).click()
  await expect(page.getByText('Your meal plan is empty')).toBeVisible()

  // Derived state: the meal's ingredient lines disappear from the list.
  await gotoTab(page, 'Grocery')
  await expect(page.getByText('Nothing to buy yet')).toBeVisible()
})

test('cooked history is persisted and survives a reload', async ({ page }) => {
  const meal = await planFirstRecipe(page)
  await gotoTab(page, 'Plan')
  await page.getByRole('button', { name: `Mark ${meal} as cooked` }).click()
  await expect(page.getByText('Your meal plan is empty')).toBeVisible()

  // cookedHistory is persisted (personal, not part of the room schema).
  const before = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('mealime-planner:v1:plan') ?? '{}'),
  )
  expect(before.cookedHistory).toHaveLength(1)
  expect(typeof before.cookedHistory[0].variantId).toBe('number')
  expect(before.cookedHistory[0].cookedAt).toBeGreaterThan(0)
  expect(before.plan).toHaveLength(0)

  await page.reload()
  const after = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('mealime-planner:v1:plan') ?? '{}'),
  )
  expect(after.cookedHistory).toEqual(before.cookedHistory)
})

test('cooking view completion offers "Mark as cooked" and records it', async ({ page }) => {
  const meal = await planFirstRecipe(page)
  await page.getByRole('dialog').getByRole('button', { name: 'Start cooking' }).click()
  const cooking = page.getByRole('dialog', { name: /Cooking / })
  await expect(cooking).toBeVisible()

  // Advance to the last step.
  const progress = await cooking.getByText(/Step 1 \/ (\d+)/).textContent()
  const total = Number(progress!.match(/Step 1 \/ (\d+)/)![1])
  const next = cooking.getByRole('button', { name: /Next/ })
  for (let i = 1; i < total; i++) await next.click()

  await cooking.locator('[data-test=mark-cooked]').click()
  await expect(cooking).not.toBeVisible()
  await expect(page.getByText('Marked as cooked ✓')).toBeVisible()

  // The meal left the plan.
  await gotoTab(page, 'Plan')
  await expect(page.getByText('Your meal plan is empty')).toBeVisible()
  await expect(page.getByRole('heading', { name: meal })).toHaveCount(0)
})