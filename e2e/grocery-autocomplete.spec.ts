import { expect, test, type Page } from '@playwright/test'
import {
  blockExternalRequests,
  expectZeroMealimeRequests,
  gotoTab,
  waitForCatalog,
} from './helpers'

/**
 * Grocery add-item autocomplete (ADR-0012/0014): baked ingredient index
 * suggestions + device-local remembered names ("mine"), live category on
 * every row, typed text row FIRST with immediate-add (ADR-0014).
 */

test.beforeEach(async ({ page }) => {
  await blockExternalRequests(page)
  await page.goto('/recipes')
  await waitForCatalog(page)
  await gotoTab(page, 'Grocery')
})

/** The add-item input (same visible label across Grocery + Shop forms). */
const input = (page: Page) => page.getByTestId('add-bar-input')

/** All visible suggestion rows (typed + row first, then ranked matches). */
function suggestionRows(page: Page) {
  return page.locator('[data-test=add-suggestion-first], [data-test=add-suggestion-row]')
}

/** All ranked-match rows (everything below the typed + row). */
function matchRows(page: Page) {
  return page.locator('[data-test=add-suggestion-row]')
}

/** The suggestion row marked with a "mine" badge. */
function mineSuggestions(page: Page) {
  return matchRows(page).filter({ has: page.locator('[data-test=mine-badge]') })
}

test('typed text row stays first with live category, + adds immediately', async ({ page }) => {
  await input(page).fill('tomato')
  const box = page.locator('[data-test=ingredient-suggestions]')
  await expect(box).toBeVisible()

  // Row 0 is the typed text itself, with the live category chip.
  const first = page.locator('[data-test=add-suggestion-first]')
  await expect(first).toHaveCount(1)
  await expect(first).toContainText('tomato')
  // "tomato" exactly matches the index entry (nameKey "tomato") → the
  // + row adopts its real category instead of the bare Other bucket.
  await expect(first.locator('[data-test=suggestion-category]')).toHaveText('Produce')

  // Ranked matches capped at 8 total rows, exact nameKey match present.
  expect(await matchRows(page).count()).toBeGreaterThan(0)
  expect(await suggestionRows(page).count()).toBeLessThanOrEqual(8)
  await expect(matchRows(page).filter({ hasText: /^tomatoes/ })).toHaveCount(0)
  await expect(page.locator('[data-test=mine-badge]')).toHaveCount(0)

  // Pressing the typed + row adds IMMEDIATELY: toast "Added to Produce",
  // custom row appears, input clears and the flow stays open.
  await first.click()
  await expect(page.getByTestId('added-toast')).toContainText('Added to Produce')
  await expect(page.getByTestId('extra-section')).toContainText('tomato')
  await expect(input(page)).toHaveValue('')
  await expect(input(page)).toBeFocused()
  await expectZeroMealimeRequests(page)
})

test('picking an index match adopts its category; unknown shows Other first', async ({ page }) => {
  // A genuinely unknown multi-word name shows the Other bucket live.
  await input(page).fill('plastic wrap')
  const first = page.locator('[data-test=add-suggestion-first]')
  await expect(first).toBeVisible()
  await expect(first.locator('[data-test=suggestion-category]')).toHaveText('Other')
  await input(page).press('Escape')

  await input(page).fill('tomato')
  await expect(page.locator('[data-test=ingredient-suggestions]')).toBeVisible()

  // The exact match "tomatoes" (Produce) is folded INTO the + row — the
  // ranked list below it no longer duplicates it.
  await expect(matchRows(page).filter({ hasText: /^tomatoes/ })).toHaveCount(0)

  // Adding via the + row commits the index category.
  await first.click()
  await expect(page.getByTestId('added-toast')).toContainText('Added to Produce')
  await expect(page.getByTestId('extra-section')).toContainText('tomato', { exact: false })
})

test('unknown item adds as custom, persists, and shows a mine badge next time', async ({ page }) => {
  const unknown = 'Triple-filtered glacier water'
  await input(page).fill(unknown)
  // Unknown text still shows a + row (category Other), still addable.
  await expect(page.locator('[data-test=add-suggestion-first]')).toBeVisible()
  await input(page).press('Enter')

  await expect(page.getByTestId('extra-section')).toContainText(unknown)

  // Persisted across reload — and remembered as a future suggestion:
  await page.reload()
  await expect(page.getByTestId('extra-section')).toContainText(unknown)

  await input(page).fill('Triple-filte')
  await expect(page.locator('[data-test=ingredient-suggestions]')).toBeVisible()
  await expect(mineSuggestions(page)).toContainText(unknown)
})

test('keyboard navigation: ArrowDown/Up move highlight, Enter adds, Escape closes', async ({ page }) => {
  await input(page).fill('tom')
  const box = page.locator('[data-test=ingredient-suggestions]')
  await expect(box).toBeVisible()

  await input(page).press('ArrowDown')
  await expect(suggestionRows(page).first()).toHaveAttribute('aria-selected', 'true')

  await input(page).press('ArrowDown')
  await expect(suggestionRows(page).nth(1)).toHaveAttribute('aria-selected', 'true')

  await input(page).press('ArrowUp')
  await expect(suggestionRows(page).first()).toHaveAttribute('aria-selected', 'true')

  // Enter adds the highlighted (+ row) — immediate add, no dialogue.
  await input(page).press('Enter')
  await expect(page.getByTestId('extra-section')).toContainText('tom')
  await expect(input(page)).toHaveValue('')

  // Escape collapses the dropdown...
  await input(page).fill('tomato paste')
  await expect(box).toBeVisible()
  await input(page).press('Escape')
  await expect(box).toHaveCount(0)

  // ...and a second Escape empties the input (the form itself stays).
  await input(page).press('Escape')
  await expect(input(page)).toHaveValue('')
})

test('combobox semantics: aria-expanded tracks open state', async ({ page }) => {
  const combo = input(page)
  await expect(combo).toHaveAttribute('role', 'combobox')
  await combo.fill('tom')
  await expect(combo).toHaveAttribute('aria-expanded', 'true')
  await combo.press('Escape')
  await expect(combo).toHaveAttribute('aria-expanded', 'false')
})

test('gluten-free and lactose-free substitutes are suggestible (ADR-0052)', async ({ page }) => {
  // The catalog names ZERO gluten-free/lactose-free ingredients, so these
  // rows come from the hand-authored SUPPLEMENTAL table. Asserted end to end
  // because the whole point is that the household can NAME a substitute: the
  // index must recognise the typed text, and the category it carries must be
  // the one the user will shop in (a GF flour landing in Bakery is a defect).
  //
  // Both names are EXACT index matches, so they are folded into the typed +
  // row (ADR-0014) rather than repeated below it — assert on row 0.
  const first = page.locator('[data-test=add-suggestion-first]')

  await input(page).fill('gluten-free bread flour')
  await expect(first).toBeVisible()
  await expect(first).toContainText('gluten-free bread flour')
  await expect(first.locator('[data-test=suggestion-category]')).toHaveText('Baking & Spices')
  // Exact match folds into row 0, so it must not also appear below.
  await expect(matchRows(page).filter({ hasText: 'gluten-free bread flour' })).toHaveCount(0)

  await input(page).fill('lactose-free butter')
  await expect(first).toBeVisible()
  await expect(first.locator('[data-test=suggestion-category]')).toHaveText('Dairy, Cheese & Eggs')

  // Adding it commits an extra under that section — the catalog's own
  // all-purpose flour keeps its category, so nothing else moved.
  await first.click()
  await expect(page.getByTestId('added-toast')).toContainText('Added to Dairy, Cheese & Eggs')
  await expect(page.getByTestId('extra-section')).toContainText('lactose-free butter')
  await expectZeroMealimeRequests(page)
})

test('the add flow also works from Shopping mode (ShopView)', async ({ page }) => {
  // Need a non-empty list to reach ShopView's add form content area; add a
  // custom item on Grocery first, then start shopping and add another one.
  await input(page).fill('Sunshade tent')
  await input(page).press('Enter')
  await expect(page.getByTestId('extra-section')).toContainText('Sunshade tent')

  await page.locator('[data-test=start-shopping]').click()
  await expect(page).toHaveURL(/\/shop$/)
  await expect(input(page).first()).toBeVisible()
  await input(page).fill('Spare fuses')
  await input(page).press('Enter')
  await expect(
    page.locator('[data-test=shop-custom-items]').filter({ hasText: 'Spare fuses' }),
  ).toBeVisible()
})
