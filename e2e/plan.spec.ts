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

test('add a recipe to the plan, totals update', async ({ page }) => {
  await gotoTab(page, 'Plan')
  await expect(page.getByText('Your meal plan is empty')).toBeVisible()

  await gotoTab(page, 'Recipes')
  const firstName = await openFirstRecipeDetail(page)
  await page.getByRole('dialog').getByRole('button', { name: 'Add to plan' }).click()

  await gotoTab(page, 'Plan')
  await expect(page.locator('main').getByText('kcal total')).toBeVisible()
  await expect(page.locator('main').getByText('meal', { exact: true })).toHaveText('meal')
  await expect(page.getByRole('heading', { level: 3, name: firstName })).toBeVisible()
})

test('plan survives a page reload (Pinia persistence)', async ({ page }) => {
  const firstName = await openFirstRecipeDetail(page)
  await page.getByRole('dialog').getByRole('button', { name: 'Add to plan' }).click()

  await page.reload()
  await waitForCatalog(page)
  await gotoTab(page, 'Plan')
  await expect(page.getByRole('heading', { level: 3, name: firstName })).toBeVisible()
  await expect(page.locator('main').getByText('meal', { exact: true })).toHaveText('meal')
})

test('removing a planned meal works', async ({ page }) => {
  const firstName = await openFirstRecipeDetail(page)
  await page.getByRole('dialog').getByRole('button', { name: 'Add to plan' }).click()

  await gotoTab(page, 'Plan')
  const removeButton = page.getByRole('button', { name: `Remove ${firstName} from plan` })
  await expect(removeButton).toBeVisible()
  await removeButton.click()
  await expect(page.getByText('Your meal plan is empty')).toBeVisible()
  await expectZeroMealimeRequests(page)
})
