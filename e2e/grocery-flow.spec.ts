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

/** Same rounding/formatting as src/lib/quantity.ts formatAmount. */
function fmt(amount: number): string {
  const rounded = Math.round(amount * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

interface IngredientInfo {
  /** Recipe's base serving count (from the "serves N" header). */
  base: number
  /** Parsed leading amount of the ingredient's quantity string. */
  amount: number
}

/** Read an ingredient's base amount + the recipe's base servings from the open detail sheet. */
async function readIngredient(page: Page, name: RegExp): Promise<IngredientInfo> {
  const sheet = page.getByRole('dialog')
  const serves = await sheet.getByText(/serves \d+/).first().textContent()
  const base = Number(serves!.match(/serves (\d+)/)![1])

  const rows = sheet.locator('ul.divide-y > li')
  // The ingredient list renders asynchronously after the sheet opens — wait
  // for it before counting, else a loaded machine returns 0 rows.
  await rows.first().waitFor()
  const n = await rows.count()
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i)
    const text = (await row.textContent()) ?? ''
    if (!name.test(text)) continue
    const qty = ((await row.locator('span').first().textContent()) ?? '').trim()
    const m = qty.match(/^([\d.]+)/)
    if (m) return { base, amount: Number(m[1]) }
  }
  throw new Error(`no parseable row found for ${name}`)
}

/** Set the detail sheet's servings to `target` using the stepper. */
async function setServings(page: Page, target: number) {
  const sheet = page.getByRole('dialog')
  for (let guard = 0; guard < 30; guard++) {
    const serves = await sheet.getByText(/serves \d+/).first().textContent()
    const current = Number(serves!.match(/serves (\d+)/)![1])
    if (current === target) return
    if (current < target) await sheet.getByRole('button', { name: 'More servings' }).click()
    else await sheet.getByRole('button', { name: 'Fewer servings' }).click()
  }
  throw new Error(`could not set servings to ${target}`)
}

/** Grocery list labels (one per grocery line). */
function groceryLines(page: Page, name: RegExp) {
  return page.locator('main label').filter({ hasText: name })
}

test('planned servings scale the grocery list', async ({ page }) => {
  await openFirstRecipeDetail(page)
  const { base, amount } = await readIngredient(page, /garlic/i)
  expect(base, 'first catalog recipe should serve fewer than 8').toBeLessThan(8)

  await setServings(page, 8)
  await page.getByRole('dialog').getByRole('button', { name: 'Add to plan' }).click()

  await gotoTab(page, 'Grocery')
  const garlic = groceryLines(page, /garlic/i)
  await expect(garlic).toHaveCount(1, { timeout: 10_000 })
  // 8 planned servings over the recipe's base `base` servings
  await expect(garlic.first()).toHaveText(new RegExp(`${fmt((amount * 8) / base)} cloves`))
})

test('shared ingredient merges into a single summed grocery line', async ({ page }) => {
  // Recipe A (first card) planned at 8 servings
  await openFirstRecipeDetail(page)
  const a = await readIngredient(page, /garlic/i)
  await setServings(page, 8)
  await page.getByRole('dialog').getByRole('button', { name: 'Add to plan' }).click()

  await gotoTab(page, 'Grocery')
  const garlic = groceryLines(page, /garlic/i)
  await expect(garlic).toHaveCount(1, { timeout: 10_000 })
  await expect(garlic.first()).toHaveText(new RegExp(`${fmt((a.amount * 8) / a.base)} cloves`))

  // Recipe B: also contains garlic — find it via ingredient search
  await gotoTab(page, 'Recipes')
  await page.getByLabel('Search recipes or ingredients').fill('Carrot Ginger-Turmeric')
  await openRecipeDetail(page, /Carrot Ginger-Turmeric Soup/)
  const b = await readIngredient(page, /garlic/i)
  // Added at its base servings (factor 1)
  await page.getByRole('dialog').getByRole('button', { name: 'Add to plan' }).click()

  await gotoTab(page, 'Grocery')
  // Merged: still one garlic line, summed across both planned meals
  await expect(garlic).toHaveCount(1, { timeout: 10_000 })
  const expected = fmt((a.amount * 8) / a.base + b.amount * (b.base / b.base))
  await expect(garlic.first()).toHaveText(new RegExp(`${expected} cloves`))
  // Provenance: the shared ingredient is marked as spanning both meals.
  const pill = garlic.first().getByText('2 recipes')
  await expect(pill).toBeVisible()
  // Accessible name carries the full list, and hovering reveals the tooltip.
  const label = await pill.getAttribute('aria-label')
  expect(label).toContain('Carrot Ginger-Turmeric Soup')
  // Tooltip shows on hover AND keyboard focus; focus is deterministic in CI
  // (hover can be intercepted by the sticky progress bar on small viewports).
  await pill.focus()
  await expect(garlic.first().getByText('Used by 2 planned meals:')).toBeVisible()
  await expectZeroMealimeRequests(page)
})

test('custom grocery items: add, dedupe, persist, remove', async ({ page }) => {
  await gotoTab(page, 'Grocery')
  // No plan yet — the add-item form is still reachable from the empty state.
  await expect(page.getByText('Nothing to buy yet')).toBeVisible()

  const input = page.getByLabel('Add a custom grocery item')
  await input.fill('Olive oil')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await input.fill('Paper towels')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  const custom = page.getByTestId('extra-section')
  await expect(custom).toContainText('Olive oil')
  await expect(custom).toContainText('Paper towels')

  // Case-insensitive dedupe: same item is not added twice.
  await input.fill('olive oil')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(custom.locator('li')).toHaveCount(2)

  // Persisted across reloads (no waitForCatalog here — we're on Grocery).
  await page.reload()
  await gotoTab(page, 'Grocery')
  await expect(page.getByTestId('extra-section')).toContainText('Paper towels')

  // Remove works.
  await page.getByRole('button', { name: 'Remove Paper towels from the grocery list' }).click()
  await expect(page.getByTestId('extra-section').locator('li')).toHaveCount(1)
})
