import { expect, test, type Page } from '@playwright/test'
import {
  blockExternalRequests,
  expectZeroMealimeRequests,
  gotoTab,
  waitForCatalog,
} from './helpers'

/**
 * Grocery add-item autocomplete (ADR-0012): baked ingredient index
 * suggestions + device-local remembered names ("mine"), category
 * dropdown, unknown names stay addable.
 */

test.beforeEach(async ({ page }) => {
  await blockExternalRequests(page)
  await page.goto('/')
  await waitForCatalog(page)
  await gotoTab(page, 'Grocery')
})

/** The add-item input (same visible label across Grocery + Shop forms). */
const input = (page: Page) => page.getByLabel('Add a custom grocery item')

/** All visible suggestion rows. */
function suggestions(page: Page) {
  return page.locator('[data-test=ingredient-suggestion]')
}

/** The suggestion row marked with a "mine" badge. */
function mineSuggestions(page: Page) {
  return page
    .locator('[data-test=ingredient-suggestion]')
    .filter({ has: page.locator('[data-test=mine-badge]') })
}

test('index suggestions are ranked with category auto-selected', async ({ page }) => {
  await input(page).fill('tomato')
  const box = page.locator('[data-test=ingredient-suggestions]')
  await expect(box).toBeVisible()

  // Ranked list is capped at 8 and includes both the exact nameKey match
  // (tomatoes, Produce) and word-boundary matches (tomato paste, Canned…;
  // tomatillo is not in this catalog, so boundary matches here are
  // "tomato paste"/"tomato sauce"-like rows).
  const rows = suggestions(page)
  expect(await rows.count()).toBeGreaterThan(0)
  expect(await rows.count()).toBeLessThanOrEqual(8)
  // Exact nameKey match "tomato" (displayed as "tomatoes") must be present.
  await expect(rows.filter({ hasText: /^tomatoes/ })).toHaveCount(1)
  await expect(page.locator('[data-test=mine-badge]')).toHaveCount(0)

  // Pick the exact match → name + category default from the index.
  await rows.filter({ hasText: /^tomatoes/ }).click()
  await expect(input(page)).toHaveValue('tomatoes')
  await expect(page.locator('[data-test=ingredient-category]')).toHaveValue('Produce')

  // Submit adds the custom row.
  await input(page).press('Enter')
  await expect(page.getByTestId('custom-items')).toContainText('tomatoes')
  await expectZeroMealimeRequests(page)
})

test('unknown item adds as custom, persists, and shows a mine badge next time', async ({ page }) => {
  const unknown = 'Triple-filtered glacier water'
  await input(page).fill(unknown)
  // Dropdown stays closed for a made-up string (no index, no custom match).
  await expect(page.locator('[data-test=ingredient-suggestions]')).toHaveCount(0)
  await input(page).press('Enter')

  await expect(page.getByTestId('custom-items')).toContainText(unknown)

  // Persisted across reload — and remembered as a future suggestion:
  await page.reload()
  await expect(page.getByTestId('custom-items')).toContainText(unknown)

  await input(page).fill('Triple-filte')
  await expect(page.locator('[data-test=ingredient-suggestions]')).toBeVisible()
  await expect(mineSuggestions(page)).toContainText(unknown)
})

test('category dropdown override works and sticks on the added row', async ({ page }) => {
  await input(page).fill('tomatoes')
  const box = page.locator('[data-test=ingredient-suggestions]')
  await expect(box).toBeVisible()

  // Default from the index via the picked suggestion:
  await suggestions(page).filter({ hasText: /^tomatoes/ }).click()
  await expect(page.locator('[data-test=ingredient-category]')).toHaveValue('Produce')
  // Override before submit:
  await page.locator('[data-test=ingredient-category]').selectOption('Household')
  await input(page).press('Enter')
  await expect(page.getByTestId('custom-items')).toContainText('tomatoes')
  // The chosen override is remembered and shown on the added row.
  await expect(
    page.locator('[data-test=custom-item-category]').filter({ hasText: 'Household' }),
  ).toBeVisible()

  // After reload the override still sticks to the added row (device-local:
  // orthogonal to the room-synced customItems strings).
  await page.reload()
  await expect(
    page.locator('[data-test=custom-item-category]').filter({ hasText: 'Household' }),
  ).toBeVisible()

  // A remembered override also becomes the next-time default: add an
  // unknown item with a category, reload, retype — the suggestion row
  // carries the "mine" badge and its remembered category default.
  const remembered = 'Sunshade tent'
  await input(page).fill(remembered)
  await page.locator('[data-test=ingredient-category]').selectOption('Kitchen')
  await input(page).press('Enter')
  await expect(page.getByTestId('custom-items')).toContainText(remembered)

  await page.reload()
  await input(page).fill(remembered.slice(0, 9))
  const mine = mineSuggestions(page).first()
  await expect(mine).toContainText(remembered)
  await mine.click()
  await expect(page.locator('[data-test=ingredient-category]')).toHaveValue('Kitchen')
})

test('keyboard navigation: ArrowDown/Up move highlight, Enter picks, Escape closes', async ({ page }) => {
  await input(page).fill('tom')
  const box = page.locator('[data-test=ingredient-suggestions]')
  await expect(box).toBeVisible()

  await input(page).press('ArrowDown')
  await expect(suggestions(page).first()).toHaveAttribute('aria-selected', 'true')

  await input(page).press('ArrowDown')
  await expect(suggestions(page).nth(1)).toHaveAttribute('aria-selected', 'true')

  await input(page).press('ArrowUp')
  await expect(suggestions(page).first()).toHaveAttribute('aria-selected', 'true')

  // Enter picks the highlighted suggestion.
  await input(page).press('Enter')
  await expect(page.locator('[data-test=ingredient-suggestions]')).toHaveCount(0)
  expect((await input(page).inputValue()).length).toBeGreaterThan(0)

  // Escape closes the dropdown.
  await input(page).fill('tomato paste')
  await expect(box).toBeVisible()
  await input(page).press('Escape')
  await expect(box).toHaveCount(0)
})

test('combobox semantics: aria-expanded tracks open state', async ({ page }) => {
  const combo = input(page)
  await expect(combo).toHaveAttribute('role', 'combobox')
  await combo.fill('tom')
  await expect(combo).toHaveAttribute('aria-expanded', 'true')
  await combo.press('Escape')
  await expect(combo).toHaveAttribute('aria-expanded', 'false')
})

test('the add flow also works from Shopping mode (ShopView)', async ({ page }) => {
  // Need a non-empty list to reach ShopView's add form content area; add a
  // custom item on Grocery first, then start shopping and add another one.
  await input(page).fill('Sunshade tent')
  await input(page).press('Enter')
  await expect(page.getByTestId('custom-items')).toContainText('Sunshade tent')

  await page.locator('[data-test=start-shopping]').click()
  await expect(page).toHaveURL(/\/shop$/)
  await expect(page.locator('[data-test=ingredient-input]').first()).toBeVisible()
  await input(page).fill('Spare fuses')
  await input(page).press('Enter')
  await expect(
    page.locator('[data-test=shop-custom-items]').filter({ hasText: 'Spare fuses' }),
  ).toBeVisible()
})
