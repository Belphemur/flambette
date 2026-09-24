import { expect, test, type Page } from '@playwright/test'
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

/** Plan the first catalog recipe (contains garlic, in Produce). */
async function planFirstRecipe(page: Page) {
  await openFirstRecipeDetail(page)
  await page.getByRole('dialog').getByRole('button', { name: 'Add to plan' }).click()
}

/**
 * Plan two recipes that share garlic, so the merged grocery line carries
 * the provenance "N recipes" pill.
 */
async function planSharedRecipes(page: Page) {
  await planFirstRecipe(page)
  await gotoTab(page, 'Recipes')
  await page.getByLabel('Search recipes or ingredients').fill('Carrot Ginger-Turmeric')
  await openRecipeDetail(page, /Carrot Ginger-Turmeric Soup/)
  await page.getByRole('dialog').getByRole('button', { name: 'Add to plan' }).click()
}

/** The grocery section whose header reads `name` (e.g. Produce). */
function sectionByName(page: Page, name: RegExp) {
  return page.getByTestId('grocery-section').filter({ hasText: name }).first()
}

/** Click every unchecked checkbox in the section until all are checked. */
async function checkAll(page: Page, section: ReturnType<typeof sectionByName>) {
  for (;;) {
    const unchecked = section.locator('[data-test="grocery-row"] input[type=checkbox]:not(:checked)')
    if ((await unchecked.count()) === 0) break
    await unchecked.first().click()
  }
}

test('a fully-checked category auto-collapses', async ({ page }) => {
  await planFirstRecipe(page)
  await gotoTab(page, 'Grocery')
  const produce = sectionByName(page, /produce/i)
  const rows = produce.locator('[data-test="grocery-row"]')
  await expect(rows).not.toHaveCount(0, { timeout: 10_000 })

  const boxes = produce.locator('[data-test="grocery-row"] input[type=checkbox]')
  const total = await boxes.count()
  expect(total).toBeGreaterThan(1)
  await checkAll(page, produce)

  // Section auto-collapsed: rows hidden, header + count pill remain.
  await expect(produce.locator('[data-test="grocery-section-rows"]')).toHaveCount(0)
  const toggle = produce.getByTestId('grocery-section-toggle')
  await expect(toggle).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(produce.getByTestId('section-count-pill')).toHaveText(`${total}/${total}`)
})

test('unchecking one item re-expands an auto-collapsed category', async ({ page }) => {
  await planFirstRecipe(page)
  await gotoTab(page, 'Grocery')
  const produce = sectionByName(page, /produce/i)
  const boxes = produce.locator('[data-test="grocery-row"] input[type=checkbox]')
  await expect(boxes.first()).toBeVisible({ timeout: 10_000 })
  const total = await boxes.count()
  await checkAll(page, produce)
  await expect(produce.locator('[data-test="grocery-section-rows"]')).toHaveCount(0)

  // Uncheck one item from shopping mode (rows are hidden on the Grocery
  // tab while the category is collapsed).
  await page.getByTestId('start-shopping').click()
  const garlicRow = page.getByTestId('shop-row').filter({ hasText: /garlic/i }).first()
  await expect(garlicRow).toBeVisible()
  await garlicRow.click()
  await page.getByTestId('exit-shopping').click()

  // Back on Grocery the category is expanded again, one item short.
  await expect(produce.locator('[data-test="grocery-row"]')).toHaveCount(total)
  await expect(produce.getByTestId('section-count-pill')).toHaveText(`${total - 1}/${total}`)

  // The auto-collapse watcher is still live: re-checking the last item
  // collapses the section again within the same mount.
  await checkAll(page, produce)
  await expect(produce.locator('[data-test="grocery-section-rows"]')).toHaveCount(0)
})

test('provenance pill sits beside the checkbox, never on top of it', async ({ page }) => {
  await planSharedRecipes(page)
  await gotoTab(page, 'Grocery')
  const garlicLabel = page.locator('main label').filter({ hasText: /garlic/i }).first()
  await expect(garlicLabel).toBeVisible({ timeout: 10_000 })

  const pill = garlicLabel.getByTestId('provenance-pill')
  await expect(pill).toBeVisible()
  const cbBox = await garlicLabel.locator('input[type=checkbox]').boundingBox()
  const pillBox = await pill.boundingBox()
  expect(cbBox).toBeTruthy()
  expect(pillBox).toBeTruthy()
  // Layout assertion that survives viewport: the pill starts at or after
  // the checkbox's right edge (no horizontal overlap of the hit areas).
  expect(pillBox!.x).toBeGreaterThanOrEqual(cbBox!.x + cbBox!.width)

  // The tooltip anchor is keyboard-focusable and the tooltip renders
  // fully (previously clipped by the truncating name span).
  await garlicLabel.locator('[data-test="provenance-pill"] [tabindex="0"]').focus()
  await expect(garlicLabel.getByText('Used by 2 planned meals:')).toBeVisible()
  await expectZeroMealimeRequests(page)
})
