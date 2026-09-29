import { expect, test, type Page } from '@playwright/test'
import {
  blockExternalRequests,
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
 * Phase 7: clear-grocery workflow + mark-as-cooked.
 *
 * Phase 9: "Clear" REMOVES the planned meals' ingredients from the
 * grocery list (persisted per meal until cooked or re-planned fresh).
 * The checkbox map and custom items are wiped as before; planned meals
 * stay in the plan, and the list renders empty until ingredients return.
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
  await expect(toast).toContainText('All items checked — clear the grocery list? Ingredients stay hidden until you cook the meals.')
  await expect(toast.locator('[data-test=toast-action-secondary]')).toContainText('Cancel')

  // Cancel aborts: toast gone, state untouched.
  await toast.locator('[data-test=toast-action-secondary]').click()
  await expect(toast).toHaveCount(0)
  await expect(page.getByText(/(\d+) \/ (\d+) items/)).toHaveText(`${total} / ${total} items`)
  await expect(page.locator('[data-test=extra-section] li')).toHaveCount(1)

  // Re-trigger (uncheck one, check it again) and confirm this time.
  await page.locator('main input[type=checkbox]:checked').first().click()
  await page.locator('main input[type=checkbox]:not(:checked)').first().click()
  await expect(toast).toContainText('All items checked — clear the grocery list? Ingredients stay hidden until you cook the meals.')
  await toast.locator('[data-test=toast-action-primary]').click()

  // Ingredients REMOVED: the list is empty even though the meal stays
  // planned. Custom items emptied; feedback toast shows.
  await expect(page.getByTestId('cleared-empty')).toBeVisible()
  await expect(page.locator('[data-test=extra-section]')).toHaveCount(0)
  await expect(
    page.getByText('Grocery list cleared — ingredients return when you plan again'),
  ).toBeVisible()
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
  await expect(toast).toContainText(
    'Clear the grocery list? Ingredients stay hidden until you cook the meals.',
  )
  await toast.locator('[data-test=toast-action-primary]').click()
  // Ingredients removed: the list empties (cleared state), meals stay planned.
  await expect(page.getByTestId('cleared-empty')).toBeVisible()
  await expect(page.locator('[data-test=clear-list]')).toHaveCount(0)
})

test('the Clear-list button works from shopping mode', async ({ page }) => {
  await planFirstRecipe(page)
  await gotoTab(page, 'Grocery')
  await page.locator('[data-test=start-shopping]').click()
  await expect(page).toHaveURL(/\/shop$/)

  // Hidden while nothing is checked.
  await expect(page.locator('[data-test=clear-list]')).toHaveCount(0)
  // Click a row from a MULTI-line section: a one-line section auto-collapses
  // the moment it is checked (ADR-0008 addendum), detaching the row
  // mid-click.
  const multiLine = page
    .locator('[data-test=shop-section]')
    .filter({ has: page.locator('[data-test=shop-section-rows] li:nth-child(2)') })
  await expect(multiLine.first()).toBeVisible()
  await multiLine.first().locator('[data-test=shop-row]').first().click()
  await expect(page.locator('[data-test=clear-list]')).toBeVisible()

  await page.locator('[data-test=clear-list]').click()
  const toast = confirmToast(page)
  await expect(toast).toContainText('Clear the grocery list?')
  await toast.locator('[data-test=toast-action-primary]').click()
  // Ingredients removed: the cleared empty-state replaces the rows even
  // though the meals are still planned.
  await expect(page.getByTestId('cleared-empty')).toBeVisible()
  await expect(page.getByTestId('shop-row')).toHaveCount(0)
  await expect(
    page.getByText('Grocery list cleared — ingredients return when you plan again'),
  ).toBeVisible()
})

test('clearing removes custom items but keeps the planned meals', async ({ page }) => {
  const meal = await planFirstRecipe(page)
  await gotoTab(page, 'Grocery')
  await addCustomItem(page, 'Olive oil')
  await checkAllGroceryItems(page)
  const toast = confirmToast(page)
  await expect(toast).toContainText('All items checked — clear the grocery list? Ingredients stay hidden until you cook the meals.')
  await toast.locator('[data-test=toast-action-primary]').click()

  // Grocery side: checkbox map + custom items gone, and the planned
  // meals' ingredients are REMOVED — the list is empty (cleared state).
  await expect(page.getByTestId('cleared-empty')).toBeVisible()
  await expect(page.locator('[data-test=extra-section]')).toHaveCount(0)
  await expect(page.getByLabel('Add a custom grocery item')).toBeVisible()

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
  await expect(toast).toContainText('All items checked — clear the grocery list? Ingredients stay hidden until you cook the meals.')
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
  await expect(page.getByText('Marked as cooked')).toBeVisible()

  // The meal left the plan.
  await gotoTab(page, 'Plan')
  await expect(page.getByText('Your meal plan is empty')).toBeVisible()
  await expect(page.getByRole('heading', { name: meal })).toHaveCount(0)
})
/* ---------- Phase 9: clear REMOVES ingredients ---------- */

/** Remove a planned meal from the Plan tab (by name). */
async function removeMealFromPlan(page: Page, name: string): Promise<void> {
  await gotoTab(page, 'Plan')
  // Plan rows carry the FULL recipe title — match as a prefix.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const remove = new RegExp(`^Remove ${escaped}[^\\r\n]* from plan$`)
  await page.getByRole('button', { name: remove }).click()
  await expect(page.getByRole('heading', { name: new RegExp(`^${escaped}[^\r\n]*$`) })).toHaveCount(0)
}

/** Re-add a recipe by name from the Recipes tab (fresh planning). */
async function reAddRecipe(page: Page, name: string): Promise<void> {
  await gotoTab(page, 'Recipes')
  await page.getByLabel('Search recipes or ingredients').fill(name.split(' ')[0])
  await openRecipeDetail(page, new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  await page.getByRole('dialog').getByRole('button', { name: 'Add to plan' }).click()
}

test('clear removes planned ingredients: list empties, plan keeps the meals', async ({
  page,
}) => {
  const meal = await planFirstRecipe(page)
  await gotoTab(page, 'Grocery')
  await expect(page.locator('main label').first()).toBeVisible({ timeout: 10_000 })

  // Check one item so the Clear-list button appears, then clear.
  await page.locator('main input[type=checkbox]').first().click()
  await page.locator('[data-test=clear-list]').click()
  await confirmToast(page).locator('[data-test=toast-action-primary]').click()

  // 0 lines despite the meal still being planned.
  await expect(page.getByTestId('cleared-empty')).toBeVisible()
  await expect(page.locator('main label').filter({ hasText: /cloves|garlic/i })).toHaveCount(0)

  // The Plan tab still shows the meal.
  await gotoTab(page, 'Plan')
  await expect(page.getByRole('heading', { name: meal })).toBeVisible()

  // (f) Reload: the cleared snapshot persists — the list stays empty.
  await page.reload()
  await gotoTab(page, 'Grocery')
  await expect(page.getByTestId('cleared-empty')).toBeVisible({ timeout: 10_000 })
  const persisted = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('mealime-planner:v1:plan') ?? '{}'),
  )
  expect(Object.keys(persisted.clearedIngredients ?? {})).toHaveLength(1)
})

test('re-adding the same recipe returns its ingredients', async ({ page }) => {
  const meal = await planFirstRecipe(page)
  await gotoTab(page, 'Grocery')
  await expect(page.locator('main label').first()).toBeVisible({ timeout: 10_000 })

  await page.locator('main input[type=checkbox]').first().click()
  await page.locator('[data-test=clear-list]').click()
  await confirmToast(page).locator('[data-test=toast-action-primary]').click()
  await expect(page.getByTestId('cleared-empty')).toBeVisible()

  // Remove + re-add the SAME recipe: fresh planning = fresh ingredients.
  await removeMealFromPlan(page, meal)
  await reAddRecipe(page, meal)

  await gotoTab(page, 'Grocery')
  await expect(page.locator('main label').first()).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('cleared-empty')).toHaveCount(0)
})

test('shared ingredient cleared by one meal still appears from the other after re-add', async ({
  page,
}) => {
  // Meal A: first catalog recipe (has garlic). Meal B: also has garlic.
  await planFirstRecipe(page)
  await gotoTab(page, 'Recipes')
  await page.getByLabel('Search recipes or ingredients').fill('Carrot Ginger-Turmeric')
  await openRecipeDetail(page, /Carrot Ginger-Turmeric Soup/)
  await page.getByRole('dialog').getByRole('button', { name: 'Add to plan' }).click()

  // Clear: BOTH meals' ingredients (including the shared garlic) hidden.
  await gotoTab(page, 'Grocery')
  await expect(page.locator('main label').first()).toBeVisible({ timeout: 10_000 })
  await page.locator('main input[type=checkbox]').first().click()
  await page.locator('[data-test=clear-list]').click()
  await confirmToast(page).locator('[data-test=toast-action-primary]').click()
  await expect(page.getByTestId('cleared-empty')).toBeVisible()

  // Re-add ONLY meal B (Carrot Ginger-Turmeric Soup): its garlic returns,
  // meal A's cleared ingredients stay hidden.
  await removeMealFromPlan(page, 'Carrot Ginger-Turmeric Soup')
  await reAddRecipe(page, 'Carrot Ginger-Turmeric Soup')

  await gotoTab(page, 'Grocery')
  const garlic = page.locator('main label').filter({ hasText: /garlic/i })
  await expect(garlic).toHaveCount(1, { timeout: 10_000 })
  // Garlic comes only from the re-added meal — no "2 recipes" pill.
  await expect(garlic.first().getByText('2 recipes')).toHaveCount(0)
})

test('marking a cleared meal cooked forgets its cleared snapshot', async ({ page }) => {
  const meal = await planFirstRecipe(page)
  await gotoTab(page, 'Grocery')
  await expect(page.locator('main label').first()).toBeVisible({ timeout: 10_000 })

  await page.locator('main input[type=checkbox]').first().click()
  await page.locator('[data-test=clear-list]').click()
  await confirmToast(page).locator('[data-test=toast-action-primary]').click()
  await expect(page.getByTestId('cleared-empty')).toBeVisible()

  // Cooking the meal removes it AND its cleared entry…
  await gotoTab(page, 'Plan')
  await page.getByRole('button', { name: `Mark ${meal} as cooked` }).click()
  await expect(page.getByText('Your meal plan is empty')).toBeVisible()
  const persisted = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('mealime-planner:v1:plan') ?? '{}'),
  )
  expect(persisted.clearedIngredients ?? {}).toEqual({})

  // …so planning it again yields fresh ingredients.
  await reAddRecipe(page, meal)
  await gotoTab(page, 'Grocery')
  await expect(page.locator('main label').first()).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('cleared-empty')).toHaveCount(0)
})
