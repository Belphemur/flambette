import { expect, test } from '@playwright/test'
import {
  blockExternalRequests,
  expectZeroMealimeRequests,
  gotoTab,
  openFirstRecipeDetail,
  recipeCards,
  waitForCatalog,
} from './helpers'

/**
 * The remembered default serving size (ADR-0037).
 *
 * Every recipe in the catalog is authored `serving_count = 6`, so before
 * this, 6 was the starting point on EVERY surface — the detail sheet, an
 * Auto-Plan pack, a History re-plan. A household that cooks for four had to
 * re-dial the same correction on every recipe. These cases pin the fix at
 * the level the user meets it: change it once, and it follows.
 */

/** The detail sheet's servings readout (`serves N`). */
async function detailServings(page: import('@playwright/test').Page): Promise<number> {
  const label = page.getByTestId('serves-label')
  await expect(label).toBeVisible()
  return Number((await label.textContent())!.replace(/\D+/g, ''))
}

test.beforeEach(async ({ page }) => {
  await blockExternalRequests(page)
})

test('a fresh install still starts at the authored 6', async ({ page }) => {
  await page.goto('/recipes')
  await waitForCatalog(page)
  await openFirstRecipeDetail(page)
  expect(await detailServings(page)).toBe(6)
  await expectZeroMealimeRequests(page)
})

test('changing servings on a recipe is remembered for the NEXT recipe', async ({ page }) => {
  await page.goto('/recipes')
  await waitForCatalog(page)

  // Drop the first recipe to 4.
  await openFirstRecipeDetail(page)
  const sheet = page.getByRole('dialog')
  for (let i = 0; i < 2; i++) await sheet.getByRole('button', { name: 'Fewer servings' }).click()
  await expect(sheet.getByTestId('serves-label')).toHaveText('serves 4')
  // Leave WITHOUT adding to plan: the memory is the point, not the plan.
  // The detail sheet is a ROUTE, so go back to the grid explicitly rather
  // than relying on Escape to reveal the cards underneath it.
  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden()
  await page.goto('/recipes')
  await waitForCatalog(page)

  // A DIFFERENT recipe now opens at 4, not at the authored 6.
  await recipeCards(page).nth(1).click()
  await expect(sheet).toBeVisible()
  await expect(sheet.getByTestId('serves-label')).toHaveText('serves 4')
  await expectZeroMealimeRequests(page)
})

test('the remembered default survives a reload', async ({ page }) => {
  await page.goto('/recipes')
  await waitForCatalog(page)
  await openFirstRecipeDetail(page)
  const sheet = page.getByRole('dialog')
  for (let i = 0; i < 2; i++) await sheet.getByRole('button', { name: 'Fewer servings' }).click()
  await expect(sheet.getByTestId('serves-label')).toHaveText('serves 4')

  // Reload the GRID: the detail sheet is its own route, so reloading it
  // would only prove the sheet re-seeded, not that the value persisted.
  await page.goto('/recipes')
  await waitForCatalog(page)
  await openFirstRecipeDetail(page)
  await expect(page.getByRole('dialog').getByTestId('serves-label')).toHaveText('serves 4')
  await expectZeroMealimeRequests(page)
})

test('the default is editable in Settings and drives new recipes', async ({ page }) => {
  await page.goto('/recipes')
  await waitForCatalog(page)

  await gotoTab(page, 'Settings')
  const value = page.getByTestId('default-servings-value')
  await expect(value).toHaveText('6')
  // Two steps down: the authored 6 becomes the household's 4.
  for (let i = 0; i < 2; i++) await page.getByTestId('default-servings-fewer').click()
  await expect(value).toHaveText('4')

  await gotoTab(page, 'Recipes')
  await openFirstRecipeDetail(page)
  await expect(page.getByRole('dialog').getByTestId('serves-label')).toHaveText('serves 4')
  await expectZeroMealimeRequests(page)
})

test('a meal already in the plan keeps the servings it was added with', async ({ page }) => {
  await page.goto('/recipes')
  await waitForCatalog(page)

  // Plan a recipe at 6, then lower the DEFAULT to 2. The planned meal is
  // the household's agreed state, not a starting point — it must not move.
  const name = await openFirstRecipeDetail(page)
  const sheet = page.getByRole('dialog')
  await sheet.getByRole('button', { name: /Add to plan|Update in plan/ }).click()

  await gotoTab(page, 'Settings')
  for (let i = 0; i < 4; i++) await page.getByTestId('default-servings-fewer').click()
  await expect(page.getByTestId('default-servings-value')).toHaveText('2')

  await gotoTab(page, 'Plan')
  const row = page.locator('main li').filter({ hasText: name })
  await expect(row.getByLabel('Servings', { exact: true })).toHaveText('6')
  await expectZeroMealimeRequests(page)
})

test('scaling a planned meal up becomes the new default', async ({ page }) => {
  await page.goto('/recipes')
  await waitForCatalog(page)
  const name = await openFirstRecipeDetail(page)
  await page.getByRole('dialog').getByRole('button', { name: /Add to plan|Update in plan/ }).click()

  await gotoTab(page, 'Plan')
  const row = page.locator('main li').filter({ hasText: name })
  await row.getByRole('button', { name: `More servings of ${name}` }).click()
  await row.getByRole('button', { name: `More servings of ${name}` }).click()
  await expect(row.getByLabel('Servings', { exact: true })).toHaveText('8')

  // The plan stepper is a statement about how this household cooks, so it
  // updates the memory exactly like the detail stepper does.
  await gotoTab(page, 'Settings')
  await expect(page.getByTestId('default-servings-value')).toHaveText('8')
  await expectZeroMealimeRequests(page)
})

test('the Settings control cannot be walked below one serving', async ({ page }) => {
  await page.goto('/recipes')
  await waitForCatalog(page)
  await gotoTab(page, 'Settings')

  const fewer = page.getByTestId('default-servings-fewer')
  const value = page.getByTestId('default-servings-value')
  // Click only while the control is enabled: at the floor it disables
  // itself, and a click() on a disabled button waits forever.
  for (let i = 0; i < 10 && (await fewer.isEnabled()); i++) await fewer.click()
  await expect(value).toHaveText('1')
  // The floor disables the control rather than storing a 0 that would
  // collapse every future recipe.
  await expect(fewer).toBeDisabled()
  await expectZeroMealimeRequests(page)
})

test('an Auto-Plan pack lands at the remembered default, not the authored 6', async ({ page }) => {
  // The third newly-routed surface. Without this, a regression that sent
  // the pack back to a hardcoded 6 would pass: the existing auto-plan
  // spec only ever runs on a fresh install, where the default IS 6.
  await page.goto('/recipes')
  await waitForCatalog(page)

  await gotoTab(page, 'Settings')
  for (let i = 0; i < 2; i++) await page.getByTestId('default-servings-fewer').click()
  await expect(page.getByTestId('default-servings-value')).toHaveText('4')

  await gotoTab(page, 'Plan')
  await page.getByTestId('auto-plan-button').first().click()
  await page.getByTestId('auto-plan-generate').click()
  await expect(page.getByTestId('auto-plan-generate')).not.toHaveText('Generating…', {
    timeout: 20_000,
  })
  await expect(page.getByTestId('auto-plan-confirm')).toBeVisible({ timeout: 20_000 })
  await page.getByTestId('auto-plan-confirm').click()

  // Every generated meal, at 4 — read from the plan list, not the store.
  const servings = await page
    .locator('main ul > li')
    .getByLabel('Servings', { exact: true })
    .allTextContents()
  expect(servings.length).toBeGreaterThan(0)
  for (const s of servings) expect(Number(s)).toBe(4)
  await expectZeroMealimeRequests(page)
})

test('an unplanned cook scales to the remembered default', async ({ page }) => {
  // The fourth newly-routed surface: CookingView's fallback when the recipe
  // has no plan entry. Asserted through the servings the cook resolved,
  // which is the value that scales every step it shows.
  await page.addInitScript(() => {
    const blob = { defaultServings: 4, stepTimers: {} }
    localStorage.setItem('mealime-planner:v1:ui', JSON.stringify(blob))
  })
  await page.goto('/recipes')
  await waitForCatalog(page)
  await openFirstRecipeDetail(page)
  // No plan entry exists, so the sheet itself shows the remembered default.
  await expect(page.getByRole('dialog').getByTestId('serves-label')).toHaveText('serves 4')

  await page.getByTestId('start-cooking').click()
  const cooking = page.getByRole('dialog', { name: /Cooking/ })
  await expect(cooking).toBeVisible()
  // The cook's own header (`data-test="cook-serves"`) is the resolved
  // value that scales every step — not a re-read of the sheet.
  await expect(cooking.getByTestId('cook-serves')).toContainText('serves 4')
  await expectZeroMealimeRequests(page)
})

test('a History re-plan adds at the remembered default', async ({ page }) => {
  // The fifth newly-routed surface. HistoryView has no stepper, so the
  // stored default is the only count it can use.
  await page.addInitScript(() => {
    const piniaState = { defaultServings: 4, stepTimers: {} }
    localStorage.setItem('mealime-planner:v1:ui', JSON.stringify(piniaState))
    // One cooked row to re-plan from.
    localStorage.setItem(
      'mealime-planner:v1:plan',
      JSON.stringify({
        plan: [],
        cookedHistory: [{ variantId: 17452, cookedAt: Date.now(), id: 'hist-1' }],
      }),
    )
  })
  await page.goto('/history')
  await expect(page.getByTestId('history-empty')).toBeHidden({ timeout: 15_000 })

  await page.getByTestId('history-add-17452').first().click()
  await gotoTab(page, 'Plan')
  await expect(page.locator('main ul > li').getByLabel('Servings', { exact: true })).toHaveText('4')
  await expectZeroMealimeRequests(page)
})

test('a hand-edited default is repaired on load, never scaled by', async ({ page }) => {
  // Hydration is a raw $patch of localStorage, so a corrupted value reaches
  // the ref verbatim. It multiplies into every recipe's scale factor, so it
  // must be repaired before it can render a recipe unusable.
  await page.addInitScript(() => {
    localStorage.setItem(
      'mealime-planner:v1:ui',
      JSON.stringify({ defaultServings: 0, stepTimers: {} }),
    )
  })
  await page.goto('/recipes')
  await waitForCatalog(page)

  await gotoTab(page, 'Settings')
  await expect(page.getByTestId('default-servings-value')).toHaveText('6')

  // The repaired value is what a recipe actually scales by, so prove it
  // on a recipe: a 0 that reached the sheet would collapse every quantity.
  await gotoTab(page, 'Recipes')
  await openFirstRecipeDetail(page)
  await expect(page.getByRole('dialog').getByTestId('serves-label')).toHaveText('serves 6')
  await expectZeroMealimeRequests(page)
})
