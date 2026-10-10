import { expect, test, type Page } from '@playwright/test'
import { blockExternalRequests, expectZeroMealimeRequests, gotoTab, waitForCatalog } from './helpers'

test.beforeEach(async ({ page }) => {
  await blockExternalRequests(page)
  await page.goto('/recipes')
  await waitForCatalog(page)
})

/**
 * Open a recipe by name via search, optionally bump servings, and add it
 * to the plan. Servings default to the recipe's authored base (6).
 */
async function planRecipe(
  page: Page,
  query: string,
  heading: string | RegExp,
  servings = 6,
) {
  await page.getByRole('searchbox', { name: 'Search recipes or ingredients' }).fill(query)
  // Wait for the FILTERED list — waitForCatalog alone passes on the stale,
  // unfiltered card list while the search debounce is still pending.
  const card = page
    .locator('main article')
    .filter({ has: page.getByRole('heading', { name: heading }) })
    .first()
  await expect(card).toBeVisible({ timeout: 10_000 })
  await card.click()
  const sheet = page.getByRole('dialog')
  await expect(sheet).toBeVisible()
  for (let i = 6; i < servings; i++) {
    await sheet.getByRole('button', { name: 'More servings' }).click()
  }
  await expect(sheet.getByTestId('serves-label')).toHaveText(`serves ${servings}`)
  await sheet.getByRole('button', { name: /Add to plan|Update in plan/ }).click()
  return sheet
}

/** Start cooking for the already-planned recipe and return the cooking dialog. */
async function startCookingFromSheet(page: Page) {
  const sheet = page.getByRole('dialog')
  await sheet.getByRole('button', { name: 'Start cooking' }).click()
  const cooking = page.getByRole('dialog', { name: /Cooking / })
  await expect(cooking).toBeVisible()
  return cooking
}

/**
 * Tuscan Kale & White Bean Soup (authored 6 servings):
 * - "6 medium carrots" / "6 cloves garlic" are LINEAR ingredients
 * - "¾ tsp crushed red pepper" / "1 ½ tsp salt" are SEASONINGS
 * None of its steps start with "Meanwhile", so views stay 1:1 with steps.
 */
test('seasonings scale sub-linearly while linear ingredients double at 12 servings', async ({
  page,
}) => {
  await planRecipe(page, 'Tuscan Kale', 'Tuscan Kale & White Bean Soup', 12)

  // (a) Seasonings in the cooking step details: sub-linear, below 2×.
  // Step 9 details: "6 cloves garlic" → linear 2× → "12 cloves garlic".
  const cooking = await startCookingFromSheet(page)
  for (let i = 0; i < 8; i++) await cooking.getByRole('button', { name: /Next/ }).click()
  await expect(cooking.getByText('12 cloves garlic')).toBeVisible()

  // Step 10: "¾ tsp crushed red pepper" → 0.75 × 2^0.75 ≈ 1.26 → ⅛ grid →
  // "1 ¼ tsp" (ADR-0055 spoon vocabulary; linear would render "1 ½ tsp").
  await cooking.getByRole('button', { name: /Next/ }).click()
  await expect(cooking.getByTestId('step-text')).toContainText(
    'Add the minced garlic and crushed red pepper',
  )
  await expect(cooking.getByText('1 ¼ tsp crushed red pepper')).toBeVisible()

  // Step 11: "1 ½ tsp salt" → 1.5 × 2^0.75 ≈ 2.52 → ⅛ grid → "2 ½ tsp"
  // (linear would be 3 tsp).
  await cooking.getByRole('button', { name: /Next/ }).click()
  await expect(cooking.getByText('2 ½ tsp salt')).toBeVisible()

  // The LINEAR renders — exactly what factor-2 scaling would produce —
  // must be invisible: the negatives pin sub-linearity, not just text.
  await expect(cooking.getByText('1 ½ tsp')).not.toBeVisible()
  await expect(cooking.getByText('3 tsp salt')).not.toBeVisible()

  // (c) Linear ingredient in the grocery list: exactly 2× the authored amount.
  await cooking.getByRole('button', { name: 'Close cooking mode' }).click()
  await gotoTab(page, 'Grocery')
  const carrotRow = page.getByTestId('grocery-row').filter({ hasText: /carrot/i })
  await expect(carrotRow).toBeVisible({ timeout: 10_000 })
  await expect(carrotRow).toContainText('12 medium')
  await expectZeroMealimeRequests(page)
})

/**
 * The cap: at 24 servings the sub-linear factor alone would give
 * 1.5 × 4^0.75 ≈ 4.24 tsp salt, but the default cap (2× the authored
 * amount) holds it at 3 tsp.
 */
test('seasoning cap holds salt at 2× the authored amount at 24 servings', async ({ page }) => {
  await planRecipe(page, 'Tuscan Kale', 'Tuscan Kale & White Bean Soup', 24)

  const cooking = await startCookingFromSheet(page)
  for (let i = 0; i < 10; i++) await cooking.getByRole('button', { name: /Next/ }).click()
  await expect(cooking.getByTestId('step-text')).toContainText('Add the beans and their liquid')
  await expect(cooking.getByText('3 tsp salt')).toBeVisible()
  await expect(cooking.getByText('4.2 tsp salt')).not.toBeVisible()
  await expect(cooking.getByText('4.3 tsp salt')).not.toBeVisible()
})

/**
 * Chicken Korma with Cauliflower Rice (14 steps) has "Meanwhile, add the
 * heavy cream…" as step 11 (1-based): it must render TOGETHER with step
 * 10, and Next must advance by two. (Found via the catalog-unique token
 * "korma" — search keeps rating order, so the query must yield a tiny
 * result set for the card to be in the first rendered batch.)
 */
test('Meanwhile steps render together and the cursor advances by two', async ({ page }) => {
  await planRecipe(page, 'korma', 'Chicken Korma')

  const cooking = await startCookingFromSheet(page)

  // Advance to step 10 (0-based 9): "Once the pot is hot…" — its next step
  // is a Meanwhile step, so both render as one view.
  for (let i = 0; i < 9; i++) await cooking.getByRole('button', { name: /Next/ }).click()
  await expect(cooking.getByTestId('step-pair')).toBeVisible()
  await expect(cooking.getByTestId('step-text')).toContainText('Once the pot is hot')
  await expect(cooking.getByTestId('step-partner-text')).toContainText(
    'Meanwhile, add the heavy cream',
  )
  await expect(cooking.getByTestId('meanwhile-divider')).toBeVisible()
  await expect(cooking.getByTestId('step-counter')).toHaveText('Steps 10–11 / 14')

  // Next from the pair skips the Meanwhile step: straight to step 12.
  await cooking.getByRole('button', { name: /Next/ }).click()
  await expect(cooking.getByTestId('step-single')).toBeVisible()
  await expect(cooking.getByTestId('step-text')).toContainText('Wash and dry cilantro')
  await expect(cooking.getByTestId('step-counter')).toHaveText('Step 12 / 14')

  // Previous returns to the pair.
  await cooking.getByRole('button', { name: /Previous/ }).click()
  await expect(cooking.getByTestId('step-counter')).toHaveText('Steps 10–11 / 14')
  await expect(cooking.getByTestId('step-partner-text')).toContainText('Meanwhile')
})
