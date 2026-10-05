import { expect, test, type Page } from '@playwright/test'
import {
  blockExternalRequests,
  dismissJoinCongrats,
  expectZeroMealimeRequests,
  waitForCatalog,
} from './helpers'

/**
 * ADR-0054: the household's own recipes are first-class catalog entries.
 *
 * Covers, in order:
 *  - the Source dropdown filters All / PRO / New and the New bucket shows
 *    the pancake (locked L1: permanent, driven by the loaded id set);
 *  - the NEW badge renders on a user recipe's card, in the same slot and
 *    visual family as the PRO chip, and never says "Mealime";
 *  - a legacy `proOnly: true` blob migrates to `source: 'pro'` at hydration;
 *  - the user recipe's detail page carries the DERIVED nutrition headline;
 *  - the meal-type Breakfast bucket counts and finds it.
 */

const PANCAKE_ID = 900001
const UI_KEY = 'mealime-planner:v1:ui'

/** The card for the pancake, wherever the grid put it. */
function pancakeCard(page: Page) {
  return page.locator(`main article[data-variant-id="${PANCAKE_ID}"]`)
}

/**
 * Seed a persisted ui blob BEFORE the app boots (the same shape the
 * quick-filters spec seeds: the persisted ui state as pinia stores it).
 */
async function seedUiState(page: Page, quickFiltersValue: unknown) {
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key as string, value as string)
    },
    [UI_KEY, JSON.stringify({ shareCookedHistory: false, quickFilters: quickFiltersValue, householdRoom: '' })],
  )
}

/**
 * Surface the pancake through the search box. It rates 0 stars, so in the
 * unfiltered grid it sorts below the render window — the same way its owner
 * would find it again.
 */
async function searchPancake(page: Page) {
  await page.getByRole('searchbox', { name: 'Search recipes or ingredients' }).fill('pancake')
  await expect(pancakeCard(page)).toBeVisible({ timeout: 15_000 })
}

async function openSourceMenu(page: Page) {
  await page.getByTestId('source-button').click()
  await expect(page.getByTestId('source-menu')).toBeVisible()
}

test.describe('user recipes and the source filter (ADR-0054)', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page)
    await page.goto('/')
    await dismissJoinCongrats(page)
    await waitForCatalog(page)
  })

  test('the source dropdown filters All / PRO / New', async ({ page }) => {
    const trigger = page.getByTestId('source-button')
    await expect(trigger).toContainText('All sources')

    // NEW: only the household's own recipes — the pancake, and it is the
    // ONLY one, so the grid must be exactly one card.
    await openSourceMenu(page)
    await page.getByTestId('source-option-new').click()
    await expect(trigger).toContainText('New')
    const cards = page.locator('main article[data-test="recipe-card"]')
    await expect(cards).toHaveCount(1)
    await expect(cards.first()).toHaveAttribute('data-variant-id', String(PANCAKE_ID))

    // PRO keeps its old meaning: a rename of the proOnly chip, never a
    // complement of 'new'. A PRO grid must NOT contain the pancake.
    await openSourceMenu(page)
    await page.getByTestId('source-option-pro').click()
    await expect(trigger).toContainText('PRO')
    await expect(cards.first()).toBeVisible()
    await expect(pancakeCard(page)).toHaveCount(0)

    // All puts it back together with the catalog. The pancake rates 0, so
    // it sorts to the BOTTOM of a 2,760-row grid and sits outside the
    // windowed render — search is how a person surfaces it, so that is how
    // the spec does too.
    await openSourceMenu(page)
    await page.getByTestId('source-option-all').click()
    await expect(trigger).toContainText('All sources')
    await searchPancake(page)
    await expectZeroMealimeRequests(page)
  })

  test('the NEW badge shows inside the window and never says Mealime', async ({ page }) => {
    await searchPancake(page)
    const card = pancakeCard(page)
    const badge = card.getByTestId('new-badge')
    await expect(badge).toHaveText('NEW')
    // The badge is a recency claim on the household's own card, so it is
    // NOT the PRO chip and never names the commercial source.
    await expect(card).not.toContainText('PRO')
    await expect(page.getByTestId('quick-filters')).not.toContainText('Mealime')
    await expectZeroMealimeRequests(page)
  })

  test('a legacy proOnly blob migrates at hydration', async ({ page }) => {
    await seedUiState(page, {
      diets: [],
      protein: [],
      maxTime: null,
      sortBy: 'latest',
      favOnly: false,
      // The retired member: carries `true -> 'pro'` on hydration.
      proOnly: true,
    })
    await page.goto('/')
    await dismissJoinCongrats(page)
    await waitForCatalog(page)
    await expect(page.getByTestId('source-button')).toContainText('PRO')
    // And the migrated filter actually applies.
    await expect(pancakeCard(page)).toHaveCount(0)
    await expectZeroMealimeRequests(page)
  })

  test('the pancake detail page shows the derived nutrition block', async ({ page }) => {
    await page.goto(`/recipe/${PANCAKE_ID}`)
    await dismissJoinCongrats(page)
    await expect(page.getByTestId('detail-title')).toContainText('Fluffy Pancakes')
    // The PERMANENT authorship marker: visible on the detail sheet with the
    // tooltip affordance (the card's NEW badge is the 30-day recency face;
    // this one never expires). A Mealime recipe must NOT carry it.
    const badge = page.getByTestId('user-recipe-badge')
    await expect(badge).toBeVisible()
    await expect(badge).toContainText('Household recipe')
    await expect(badge).toHaveAttribute('title', /authored by this household/)
    await page.goto('/recipe/17452')
    await expect(page.getByTestId('user-recipe-badge')).toHaveCount(0)
    // The per-serving headline comes from meta.calories, which the authoring
    // script DERIVED from the committed CIQUAL table (never hand-typed):
    // 381.53 kcal at 8 servings, displayed rounded to 382. The sodium line
    // is the same derivation (850.4 mg -> 850).
    // The facts modal opens and shows real derived rows, sodium included.
    await page.goto(`/recipe/${PANCAKE_ID}`)
    await dismissJoinCongrats(page)
    await expect(page.getByTestId('detail-title')).toContainText('Fluffy Pancakes')
    await page.getByTestId('nutrition-open').click()
    await expect(page.getByTestId('nutrition-group-minerals')).toContainText('Sodium')
    await expectZeroMealimeRequests(page)
  })

  test('the meal-type Breakfast bucket counts and finds the pancake', async ({ page }) => {
    await page.getByTestId('mealtype-button').click()
    const menu = page.getByTestId('mealtype-menu')
    await expect(menu).toBeVisible()
    // The committed recipe_types.json regenerated with the pancake: 152.
    const breakfast = page.getByTestId('mealtype-option-Breakfast')
    await expect(breakfast).toContainText('152')
    await breakfast.click()
    await searchPancake(page)
    await expectZeroMealimeRequests(page)
  })
})
