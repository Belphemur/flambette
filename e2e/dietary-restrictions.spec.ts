/**
 * Dietary restrictions (the restriction ADR — ADR-0056).
 *
 * Settings selector → catalog filter → upstream-faithful substitution, all
 * OFFLINE (the artifacts ship in the bundle; `expectZeroMealimeRequests`
 * proves no mealime.com host is ever touched). Fixtures measured live:
 * GF removes rid 50 (variant 4788, "…Couscous") and reworks rid 2195
 * (variant 18895) whose `rotini pasta` line becomes `gluten-free rotini
 * pasta` upstream's own rendering.
 *
 * The load-bearing rule under test: the DISPLAYED name is the reworked one,
 * while every persisted key stays the BASE doc's — checking a grocery row,
 * flipping the unit system and reloading must leave the check intact.
 */
import { expect, test, type Page } from '@playwright/test'
import {
  blockExternalRequests,
  expectZeroMealimeRequests,
  gotoTab,
  recipeCards,
  waitForCatalog,
} from './helpers'

// 'rotini' matches only 50 variants and includes 18895; the display order is
// catalog order (not search rank) and only ~60 cards render per batch, so the
// long recipe NAME would OR-match >1500 variants and never render the target.
const STILL_SHOWN = 'rotini'
const SWAPPED = 'gluten-free rotini pasta'
const BASE_NAME = 'rotini pasta'

async function searchRecipes(page: Page, query: string) {
  await page.getByRole('searchbox', { name: 'Search recipes or ingredients' }).fill(query)
}

async function activateGlutenFree(page: Page) {
  await page.goto('/settings')
  await page.getByTestId('restriction-chip-gluten-free').click()
  await expect(page.getByTestId('restriction-chip-gluten-free')).toHaveAttribute(
    'aria-pressed',
    'true',
  )
}

test.beforeEach(async ({ page }) => {
  await blockExternalRequests(page)
})

test.afterEach(async ({ page }) => {
  await expectZeroMealimeRequests(page)
})

test('the selector offers the twelve upstream restrictions and persists the choice', async ({
  page,
}) => {
  await page.goto('/settings')
  await expect(page.getByTestId('dietary-restrictions')).toBeVisible()
  const chips = page.locator('[data-test^="restriction-chip-"]')
  await expect(chips).toHaveCount(12)

  const gf = page.getByTestId('restriction-chip-gluten-free')
  await expect(gf).toHaveAttribute('aria-pressed', 'false')
  await gf.click()
  await expect(gf).toHaveAttribute('aria-pressed', 'true')

  // The choice persists across a reload (ui.dietaryRestrictionIds).
  await page.reload()
  await expect(page.getByTestId('restriction-chip-gluten-free')).toHaveAttribute(
    'aria-pressed',
    'true',
  )
})

const cardFor = (page: Page, name: string | RegExp) =>
  recipeCards(page).filter({ has: page.getByRole('heading', { name }) })

test('an active restriction removes its recipes from discovery (search included)', async ({
  page,
}) => {
  await page.goto('/recipes')
  await waitForCatalog(page)
  // 'couscous' matches 43 recipes — one batch renders them all, so the
  // SPECIFIC removed card is asserted, not the whole result count.
  await searchRecipes(page, 'couscous')
  await expect(cardFor(page, /Cauliflower & Chickpea Coconut Curry with Couscous/)).toHaveCount(1)

  await activateGlutenFree(page)

  await gotoTab(page, 'Recipes')
  await waitForCatalog(page)
  await searchRecipes(page, 'couscous')
  await expect(cardFor(page, /Cauliflower & Chickpea Coconut Curry with Couscous/)).toHaveCount(0)
  // A recipe the rework KEPT still shows (substituted doc survives).
  await searchRecipes(page, STILL_SHOWN)
  await expect(cardFor(page, /White Bean Pasta Salad/)).toHaveCount(1)
})

test('a recipe that survives shows the substituted ingredient name', async ({ page }) => {
  await activateGlutenFree(page)
  await page.goto('/recipes')
  await waitForCatalog(page)
  await searchRecipes(page, STILL_SHOWN)
  await cardFor(page, /White Bean Pasta Salad/).first().click()
  const sheet = page.getByRole('dialog')
  await expect(sheet).toBeVisible()
  // Upstream's own restricted rendering — the overlay line, verbatim. The
  // text legitimately appears twice (the ingredient li AND its measured
  // amount chip), so assert the first.
  await expect(sheet.getByText(SWAPPED).first()).toBeVisible()
})

test('the grocery row shows the substituted name and the checkbox key survives units + reload', async ({
  page,
}) => {
  await activateGlutenFree(page)
  await page.goto('/recipes')
  await waitForCatalog(page)
  await searchRecipes(page, STILL_SHOWN)
  await cardFor(page, /White Bean Pasta Salad/).first().click()
  const sheet = page.getByRole('dialog')
  await expect(sheet).toBeVisible()
  await sheet.getByTestId('add-to-plan').click()
  await page.keyboard.press('Escape')

  await gotoTab(page, 'Grocery')
  const row = page.getByTestId('grocery-row').filter({ hasText: SWAPPED }).first()
  await expect(row).toBeVisible()
  // The row is grouped under the BASE name's key: checking it, toggling
  // units and reloading must not orphan the check (the key/display split).
  // click(), not check(): the checked-sink re-sort MOVES the row on the
  // false→true transition, and the section auto-collapses under it
  // (ADR-0008), so a post-click re-verification of the same locator races.
  await row.locator('input[type="checkbox"]').click()
  // The check landed: the section's pill reads 1/1 and the section has
  // auto-collapsed (the row is gone from the DOM).
  const section = page
    .getByTestId('grocery-section')
    .filter({ hasText: /Pasta & Sauces/ })
  await expect(section.locator('[data-test="section-count-pill"]')).toHaveText('1/1')

  await gotoTab(page, 'Settings')
  await page.getByTestId('unit-system-imperial').click()
  await expect(page.getByTestId('unit-system-imperial')).toHaveAttribute('aria-pressed', 'true')

  await page.reload()
  await gotoTab(page, 'Grocery')
  // The collapse persisted; re-expand the section to see the row again.
  // WAIT for collapsed first: the collapse state applies asynchronously
  // after the first render, so an immediate click can land while the
  // section is still expanded and COLLAPSE it instead.
  const reloadedSection = page
    .getByTestId('grocery-section')
    .filter({ hasText: /Pasta & Sauces/ })
  const reloadedToggle = reloadedSection.getByTestId('grocery-section-toggle')
  await expect(reloadedToggle).toHaveAttribute('aria-expanded', 'false')
  await reloadedToggle.click()
  const reloaded = page.getByTestId('grocery-row').filter({ hasText: SWAPPED }).first()
  await expect(reloaded).toBeVisible()
  await expect(reloaded.locator('input[type="checkbox"]')).toBeChecked()
  // The substituted name survives the reload too.
  await expect(reloaded.getByText(SWAPPED).first()).toBeVisible()
})
