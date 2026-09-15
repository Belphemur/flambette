import { expect, test } from '@playwright/test'
import {
  blockExternalRequests,
  expectZeroMealimeRequests,
  gotoTab,
  openFirstRecipeDetail,
  waitForCatalog,
} from './helpers'

test.beforeEach(async ({ page }) => {
  await blockExternalRequests(page)
  await page.goto('/')
  await waitForCatalog(page)
})

/** Add the first recipe of the catalog to the plan; returns its name. */
async function planFirstRecipe(page: import('@playwright/test').Page) {
  const firstName = await openFirstRecipeDetail(page)
  await page.getByRole('dialog').getByRole('button', { name: 'Add to plan' }).click()
  return firstName
}

test('grocery tab shows section groups for a planned meal', async ({ page }) => {
  await planFirstRecipe(page)

  await gotoTab(page, 'Grocery')
  const progress = page.locator('main').getByText(/\d+ \/ \d+ items/)
  await expect(progress).toBeVisible({ timeout: 10_000 })
  const total = Number((await progress.textContent())!.match(/(\d+) items/)![1])
  expect(total).toBeGreaterThan(5)
  // Canonical store sections are rendered as group headings
  const sectionHeadings = page.locator('main h3').filter({ hasText: /\S/ })
  await expect(sectionHeadings.first()).toBeVisible()
  expect(await sectionHeadings.count()).toBeGreaterThanOrEqual(2)
})

test('checking an item updates the progress count, reload keeps it', async ({ page }) => {
  await planFirstRecipe(page)

  await gotoTab(page, 'Grocery')
  const progress = page.locator('main').getByText(/\d+ \/ \d+ items/)
  await expect(progress).toBeVisible({ timeout: 10_000 })
  const total = (await progress.textContent())!.match(/(\d+) items/)![1]
  await expect(progress).toHaveText(`0 / ${total} items`)

  // Check the first grocery line
  const firstCheckbox = page.locator('main input[type="checkbox"]').first()
  await firstCheckbox.check()
  await expect(progress).toHaveText(`1 / ${total} items`)

  // Reload — the checked state must persist (Pinia persistedstate)
  await page.reload()
  await expect(page.locator('main').getByText(/\d+ \/ \d+ items/)).toHaveText(`1 / ${total} items`, {
    timeout: 10_000,
  })
  await expect(page.locator('main input[type="checkbox"]').first()).toBeChecked()
  await expectZeroMealimeRequests(page)
})
