import { expect, test, type Page } from '@playwright/test'
import {
  blockExternalRequests,
  dismissJoinCongrats,
  expectZeroMealimeRequests,
  waitForCatalog,
} from './helpers'

/**
 * ADR-0054 (as re-scoped by ADR-0105): the household's own recipes are
 * first-class catalog entries.
 *
 * Covers, in order:
 *  - the Source dropdown filters All / New and the New bucket shows the
 *    pancake (locked L1: permanent, driven by the loaded id set) — the
 *    retired PRO option is gone from the menu;
 *  - the NEW badge renders on a user recipe's card and never says
 *    "Mealime" (ADR-0105 retired the PRO chip it used to pair with);
 *  - a legacy `proOnly: true` blob lands on All at hydration (ADR-0105
 *    dropped the migration);
 *  - the user recipe's detail page carries the DERIVED nutrition headline;
 *  - the meal-type Breakfast bucket counts and finds it.
 */

const PANCAKE_ID = 900001
const UI_KEY = 'mealime-planner:v1:ui'

/** The fixture pancake's `addedAt` in public/data/user_recipes.json (2026-10-01T00:00:00Z). */
const PANCAKE_ADDED_AT = 1_790_812_800_000
/**
 * The frozen clock for the badge test: one day after the fixture's add, so
 * the NEW badge is inside its 30-day recency window FOREVER — written as an
 * expression over the same literal so a fixture re-date cannot desync it.
 * A wall-clock-based freeze re-broke this spec when the real date crossed
 * 30 days past the fixture (CI run 43918800557); a fixed constant cannot.
 * The out-of-window side is unit-covered in src/lib/userRecipes.test.ts.
 */
const FAKE_NOW = PANCAKE_ADDED_AT + 24 * 3_600_000

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
    await page.goto('/recipes')
    await dismissJoinCongrats(page)
    await waitForCatalog(page)
  })

  test('the source dropdown filters All / New with no PRO option', async ({ page }) => {
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

    // ADR-0105: the PRO option is retired — the menu offers exactly two
    // options, and a grid can never show a PRO chip again.
    await openSourceMenu(page)
    await expect(page.getByTestId('source-option-pro')).toHaveCount(0)
    const menuText = await page.getByTestId('source-menu').innerText()
    expect(menuText).not.toContain('PRO')
    await page.keyboard.press('Escape')

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
    // Freeze the clock on a FIXED constant, not runtime Date.now(): the
    // addInitScript callback cannot reference module scope, so the value
    // crosses as an argument. Re-goto applies the stub before the app boots.
    await page.addInitScript(
      (now) => {
        Date.now = () => now
      },
      FAKE_NOW,
    )
    await page.goto('/recipes')
    await dismissJoinCongrats(page)
    await waitForCatalog(page)
    await searchPancake(page)
    const card = pancakeCard(page)
    const badge = card.getByTestId('new-badge')
    await expect(badge).toHaveText('NEW')
    // The badge is a recency claim on the household's own card (ADR-0105
    // retired the PRO chip it used to share a corner with), so the card
    // never names a commercial source or a plan tier.
    await expect(card).not.toContainText('PRO')
    await expect(page.getByTestId('quick-filters')).not.toContainText('Mealime')
    await expectZeroMealimeRequests(page)
  })

  test('a legacy proOnly blob lands on All at hydration (ADR-0105)', async ({ page }) => {
    await seedUiState(page, {
      diets: [],
      protein: [],
      maxTime: null,
      sortBy: 'latest',
      favOnly: false,
      // The retired member: DROPPED on hydration — the PRO facet no
      // longer exists, so the tab opens on All instead.
      proOnly: true,
    })
    await page.goto('/recipes')
    await dismissJoinCongrats(page)
    await waitForCatalog(page)
    await expect(page.getByTestId('source-button')).toContainText('All sources')
    // And the drop actually restores the catalog: a PRO recipe would be
    // visible here, so All is the whole grid, not a narrowed slice.
    await searchPancake(page)
    await expectZeroMealimeRequests(page)
  })

  test('the pancake detail page shows the derived nutrition block', async ({ page }) => {
    await page.goto(`/recipe/${PANCAKE_ID}`)
    await dismissJoinCongrats(page)
    await expect(page.getByTestId('detail-title')).toContainText('Fluffy Pancakes')
    // The PERMANENT authorship marker: visible on the detail sheet (the
    // card's NEW badge is the 30-day recency face; this one never
    // expires). ADR-0055: the native `title` became the one bubble —
    // aria-hidden, revealed on hover and, being the detail view, by
    // tap-reveal. Owner refinement (2026-10-06): the BUBBLE text is just
    // "New"; the full meaning stays in the aria-label (the carrier).
    const badge = page.getByTestId('user-recipe-badge')
    await expect(badge).toBeVisible()
    await expect(badge.locator('span[aria-hidden="true"]').last()).toHaveText('New')
    await expect(badge.locator('svg')).toHaveAttribute('aria-label', /authored by this household/)
    // Icon-only marker, same row as the type/occasion icons: no text pill;
    // the household hue lives on the glyph inside the wrapper.
    await expect(badge.locator('svg')).toHaveClass(/text-household/)
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
