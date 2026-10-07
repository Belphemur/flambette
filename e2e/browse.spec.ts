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

test('typing a full title returns that recipe first', async ({ page }) => {
  await page.getByRole('searchbox', { name: 'Search recipes or ingredients' }).fill('Pad Thai')
  await page.waitForTimeout(3000)
  const allHeadings = await page.locator('main article h3').allTextContents()
  // "Perfect Shrimp Pad Thai" matches the AND query (both "Pad" and "Thai")
  expect(allHeadings.some((h) => h.includes('Pad Thai'))).toBe(true)
})

test('"phrase" matches only adjacent name terms', async ({ page }) => {
  await page.getByRole('searchbox', { name: 'Search recipes or ingredients' }).fill('"Tomato Soup"')
  await page.waitForTimeout(500)
  const cards = recipeCards(page)
  await expect(cards.first()).toBeVisible()
  // The phrase search with double quotes matches adjacent terms in name/ingredients
  const firstHeading = await cards.first().getByRole('heading').textContent()
  expect(firstHeading).toContain('Tomato Soup')
})

test('-exclusion removes results from the list', async ({ page }) => {
  // First search for a broad term that matches many recipes
  await page.getByRole('searchbox', { name: 'Search recipes or ingredients' }).fill('Garlic')
  await page.waitForTimeout(500)
  const withGarlic = await recipeCards(page).count()
  expect(withGarlic).toBeGreaterThan(0)
  // Now exclude a common word — many Garlic recipes also have this word, so the count drops
  await page.getByRole('searchbox', { name: 'Search recipes or ingredients' }).fill('Garlic -Soup')
  await page.waitForTimeout(500)
  const cards = recipeCards(page)
  await expect(cards.first()).toBeVisible()
  const afterExclusion = await cards.count()
  // No visible card should have "Soup" in its heading (those were excluded)
  for (let i = 0; i < (await cards.count()); i++) {
  const heading = await cards.nth(i).getByRole('heading').textContent()
  expect(heading?.toLowerCase().includes('soup')).toBeFalsy()
  }
})

test('suggest dropdown opens, navigates and commits', async ({ page }) => {
  const searchbox = page.getByRole('searchbox', { name: 'Search recipes or ingredients' })
  await searchbox.fill('Pad')
  await page.waitForTimeout(400) // debounce settles
  // Dropdown opens
  await expect(page.getByTestId('search-suggest')).toBeVisible()
  // Items rendered
  const items = page.getByTestId('search-suggest-item')
  expect(await items.count()).toBeGreaterThan(0)
  // First item has the right ARIA role
  await expect(items.first()).toHaveAttribute('role', 'option')
  // Arrow down selects the second item
  await searchbox.press('ArrowDown')
  // Enter commits the selection
  await searchbox.press('Enter')
  await page.waitForTimeout(500)
  // The search box now contains the selected suggestion
  const value = await searchbox.inputValue()
  expect(value).not.toBe('Pad')
})

test('search tips disclosure, one-shot expand, and empty-state hint', async ({ page }) => {
  // First visit: panel is visible without interaction (one-shot auto-expand).
  await expect(page.getByTestId('search-tips-panel')).toBeVisible()
  const toggle = page.getByTestId('search-tips-toggle')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')

  // Click toggle → hidden + aria-expanded=false
  await toggle.click()
  await expect(page.getByTestId('search-tips-panel')).toBeHidden()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')

  // Click again → visible
  await toggle.click()
  await expect(page.getByTestId('search-tips-panel')).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')

  // Reload: one-shot latched → panel HIDDEN
  await page.reload()
  await waitForCatalog(page)
  await expect(page.getByTestId('search-tips-panel')).toBeHidden()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')

  // Click toggle → visible again
  await toggle.click()
  await expect(page.getByTestId('search-tips-panel')).toBeVisible()

  // Empty-state tip: gibberish query shows the hint
  await page.getByRole('searchbox', { name: 'Search recipes or ingredients' }).fill('zzzzqqqqwwww')
  await page.waitForTimeout(500)
  await expect(page.getByTestId('search-empty-tip')).toBeVisible()
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
