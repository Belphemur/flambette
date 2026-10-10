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
  await page.goto('/recipes')
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

test('the search field is the tab’s biggest control', async ({ page }) => {
  // ADR-0077: the render's search band is a single dominant well — leading
  // glyph, 16px type, 48px tall — so the field reads FIRST on the tab.
  // One component serves both mounts (ADR-0070), and the query role is what
  // every spec addresses, so this asserts METRICS, not identity.
  const field = page.getByRole('searchbox', { name: 'Search recipes or ingredients' })
  await expect(field).toBeVisible()
  const box = (await field.boundingBox())!
  expect(box.height).toBeGreaterThanOrEqual(48)
  expect(await field.evaluate((el) => getComputedStyle(el).fontSize)).toBe('16px')
  // Bigger than the filter controls it sits above, and wider than any of
  // them: the field, not a chip, is the tab's primary control.
  const chip = (await page.getByTestId('favourites-filter').boundingBox())!
  expect(box.height).toBeGreaterThan(chip.height)
  if (!(await page.getByTestId('app-version').isVisible())) return
  const version = (await page.getByTestId('app-version').boundingBox())!
  expect(box.width).toBeGreaterThan(version.width)
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
  // A PREFIX with completions, not a complete word: a complete word
  // ("rice", "pad") hides the dropdown — offering the word back is noise.
  await searchbox.fill('chick')
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
  expect(value).not.toBe('chick')
})

test('Enter with nothing highlighted dismisses the dropdown and blurs the searchbox', async ({ page }) => {
  const searchbox = page.getByRole('searchbox', { name: 'Search recipes or ingredients' })
  await searchbox.fill('chick')
  await page.waitForTimeout(400) // debounce settles
  await expect(page.getByTestId('search-suggest')).toBeVisible()
  // The mobile bug (ADR-0064 §4): with the dropdown OPEN but nothing
  // highlighted, Enter used to be a no-op — the menu stayed up and the
  // on-screen keyboard never closed. Enter must dispose the menu AND
  // blur the input; blur is the accepted proxy for "keyboard closed",
  // which is not scriptable.
  await searchbox.press('Enter')
  await expect(page.getByTestId('search-suggest')).toBeHidden()
  await expect(searchbox).not.toBeFocused()
})

test('Enter keeps the dropdown dismissed while suggest work is pending', async ({ page }) => {
  const searchbox = page.getByRole('searchbox', { name: 'Search recipes or ingredients' })
  // Regression: Enter dismisses the dropdown WITHOUT changing the query,
  // so the pending 150 ms suggest timer (or its in-flight response) used
  // to pass the query-only stale guard and restore the menu over the
  // results. Press Enter INSIDE the suggest debounce window, before any
  // suggestion lands, and the menu must stay gone for good.
  await searchbox.fill('chick')
  await page.waitForTimeout(100) // suggest timer armed, not yet fired
  await searchbox.press('Enter')
  await page.waitForTimeout(500) // the pending work would have landed by now
  await expect(page.getByTestId('search-suggest')).toBeHidden()
  await expect(searchbox).not.toBeFocused()
})

test('suggest dropdown hides for a complete word with no completions', async ({ page }) => {
  const searchbox = page.getByRole('searchbox', { name: 'Search recipes or ingredients' })
  // "rice" is a word the index knows: the suggester would answer with the
  // word itself + fuzzy neighbours ("rich", "ice"). None of that is a
  // completion, so the dropdown must hide itself — and the RESULTS for
  // "rice" must still appear (the dropdown is an aid, never a gate).
  await searchbox.fill('rice')
  await page.waitForTimeout(400)
  await expect(page.getByTestId('search-suggest')).toBeHidden()
  await expect(page.getByTestId('recipe-grid')).toBeVisible()
  const cards = page.getByTestId('recipe-grid').getByRole('article')
  expect(await cards.count()).toBeGreaterThan(0)
})

test('search tips disclosure starts closed and toggles; empty-state hint', async ({ page }) => {
  // First visit: the panel is CLOSED — first paint shows results, not help.
  await expect(page.getByTestId('search-tips-panel')).toBeHidden()
  const toggle = page.getByTestId('search-tips-toggle')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')

  // Click toggle → visible + aria-expanded=true
  await toggle.click()
  await expect(page.getByTestId('search-tips-panel')).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')

  // Click again → hidden
  await toggle.click()
  await expect(page.getByTestId('search-tips-panel')).toBeHidden()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')

  // Reload: still closed by default (the panel is pure user-toggle state).
  await page.reload()
  await waitForCatalog(page)
  await expect(page.getByTestId('search-tips-panel')).toBeHidden()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')

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
  // ADR-0077: the checklist card's head is the H plus the "Scaled for N"
  // pill (the servings live on the metadata strip now).
  await expect(sheet.getByRole('heading', { name: 'Ingredients' })).toBeVisible()
  await expect(sheet.getByTestId('ingredients-scaled-for')).toHaveText(/Scaled for \d+/)
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
