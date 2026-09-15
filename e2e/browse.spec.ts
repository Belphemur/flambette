import { expect, test } from '@playwright/test'
import {
  blockExternalRequests,
  expectZeroMealimeRequests,
  openRecipeDetail,
  recipeCards,
  waitForCatalog,
} from './helpers'

test.beforeEach(async ({ page }) => {
  await blockExternalRequests(page)
  await page.goto('/')
  await waitForCatalog(page)
})

test('catalog loads and recipe cards are visible', async ({ page }) => {
  const cards = recipeCards(page)
  const count = await cards.count()
  expect(count).toBeGreaterThan(50)
  // Every card shows a name, calories and cook time
  await expect(cards.first().getByRole('heading')).toContainText(/\S/)
  await expect(cards.first()).toContainText(/kcal/)
  await expect(cards.first()).toContainText(/min/)
})

test('search "lentil" narrows the results', async ({ page }) => {
  const before = await recipeCards(page).count()
  await page.getByRole('searchbox', { name: 'Search recipes or ingredients' }).fill('lentil')
  const cards = recipeCards(page)
  await expect(cards.first()).toBeVisible()
  const after = await cards.count()
  expect(after).toBeGreaterThan(0)
  expect(after).toBeLessThan(before)
  expect(await cards.count()).toBeLessThan(200) // indexed search narrows hard
})

test('misspelling still matches via fuzzy search', async ({ page }) => {
  await page.getByRole('searchbox', { name: 'Search recipes or ingredients' }).fill('lantils')
  const cards = recipeCards(page)
  await expect(cards.first()).toBeVisible({ timeout: 10_000 })
  expect(await cards.count()).toBeGreaterThan(10) // fuzzy matches the "lentil" family
})

test('detail sheet shows ingredients and instructions from the local JSON', async ({ page }) => {
  const firstName = await recipeCards(page).first().getByRole('heading').textContent()
  await openRecipeDetail(page, firstName!.trim())
  const sheet = page.getByRole('dialog')
  await expect(sheet.getByRole('heading', { level: 2 })).toHaveText(firstName!.trim())
  await expect(sheet.getByText(/Ingredients \(\d+ servings\)/)).toBeVisible()
  await expect(sheet.getByText('Instructions')).toBeVisible()
  // Scaled ingredient lines rendered from the per-variant local JSON document
  await expect(sheet.locator('li').filter({ hasText: /\S/ }).first()).toBeVisible()
  // Both requests above must have gone to localhost only
  await expectZeroMealimeRequests(page)
})

test('zero requests to mealime.com hosts while browsing', async ({ page }) => {
  await page.getByRole('searchbox', { name: 'Search recipes or ingredients' }).fill('lentil')
  await recipeCards(page).first().click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expectZeroMealimeRequests(page)
})
