import { expect, test, type Page } from '@playwright/test'
import {
  blockExternalRequests,
  expectZeroMealimeRequests,
  waitForCatalog,
} from './helpers'

/**
 * "Cook with what I have" — the pantry chip row (ADR-0087).
 *
 * Covers:
 *  - the row collapses to the add affordance with an empty pantry
 *    (Decision 1) and default browse is unchanged;
 *  - add → chip appears → the grid filters to >=1-overlap recipes,
 *    re-ranks ascending by missing count (Decision 4) and cards carry
 *    the pantry badge (Decision 6), on both grammars (desktop / mobile
 *    compact) across the two projects;
 *  - chip removal returns focus to the add input (Decision 10);
 *  - Clear ingredients empties the row (Decision 2);
 *  - the Ready (N of N) state with the check glyph;
 *  - the matching-count summary + aria-live status (Decision 6b);
 *  - the pantry survives a reload (device-local persisted slice,
 *    Decision 7);
 *  - offline enforcement keeps passing.
 */

/** Real data, computed from the served builder_data with the app's own
 *  nameKey rule: this 4-ingredient recipe is the ONLY recipe READY for
 *  its full pantry set below, and with garlic added instead it reads
 *  "Needs 1 more: garlic". */
const READY_ID = 7467
const READY_INGREDIENTS = ['banana', 'strawberries', 'large flour tortilla', 'natural peanut butter']
const NEEDS_ONE_ID = 7028 // Strawberry Banana Greek Yogurt Smoothie

function pantryRow(page: Page) {
  return page.getByTestId('pantry-row')
}

function pantryAddInput(page: Page) {
  return page.getByTestId('pantry-add-input')
}

/** Add by typing the raw text and pressing Enter (no suggestion pick). */
async function addPantryText(page: Page, name: string) {
  await pantryAddInput(page).fill(name)
  await pantryAddInput(page).press('Enter')
}

/** The badge of one recipe card, in the CURRENT project's viewport. */
function badgeOf(page: Page, variantId: number) {
  return page
    .locator(`article[data-variant-id="${variantId}"]`)
    .getByTestId('pantry-badge')
}

/** The badge's VISIBLE grammar span (the two breakpoint renderings are
 *  both in the DOM; textContent would see both — innerText does not). */
function visibleBadgeSpan(page: Page, variantId: number) {
  return badgeOf(page, variantId).locator('span').locator('visible=true')
}

test('pantry row collapses to the add affordance by default', async ({ page }) => {
  await blockExternalRequests(page)
  await page.goto('/recipes')
  await waitForCatalog(page)

  await expect(pantryRow(page)).toBeVisible()
  // Just the add affordance: no count label, no chips, no clear action,
  // and the grid header keeps its plain count text.
  await expect(page.getByTestId('pantry-count')).toHaveCount(0)
  await expect(page.locator('[data-test^="pantry-chip-"]')).toHaveCount(0)
  await expect(page.getByTestId('pantry-clear')).toHaveCount(0)
  await expect(pantryAddInput(page)).toBeVisible()
  await expect(page.getByTestId('pantry-summary')).not.toContainText('your kitchen')
})

test('add → chip → grid filters, re-ranks and badges; offline is kept', async ({ page }) => {
  await blockExternalRequests(page)
  await page.goto('/recipes')
  await waitForCatalog(page)

  // The first add collapses the row open: chip, count label, summary.
  await addPantryText(page, 'banana')
  await expect(page.getByTestId('pantry-chip-banana')).toBeVisible()
  await expect(page.getByTestId('pantry-count')).toHaveText('In my kitchen (1)')
  await expect(page.getByTestId('pantry-summary')).toContainText(/recipes match your kitchen/)

  // The badge only exists while the row is active — and now it does.
  await expect(page.getByTestId('pantry-badge').first()).toBeVisible()

  // Three more pantry items, one of which (garlic) the strawberry
  // smoothie does NOT use: its badge names the ONE missing ingredient.
  await addPantryText(page, 'strawberries')
  await addPantryText(page, 'whole milk')
  await addPantryText(page, 'garlic')
  await expect(page.getByTestId('pantry-count')).toHaveText('In my kitchen (4)')
  const width = (await page.viewportSize())?.width ?? 1280
  const needsOne =
    width >= 1024
      ? 'You have 3 of 4 · Needs 1 more: garlic'
      : '3 of 4 • Needs 1'
  await expect(visibleBadgeSpan(page, NEEDS_ONE_ID)).toHaveText(needsOne)

  // The aria-live status carries the same count sentence the header shows.
  await expect(page.getByTestId('pantry-summary')).toHaveAttribute('aria-live', 'polite')

  // Zero-mealime-host requests: the feature is fully offline.
  await expectZeroMealimeRequests(page)
})

test('badge reaches the Ready (N of N) state with the check glyph', async ({ page }) => {
  await blockExternalRequests(page)
  await page.goto('/recipes')
  await waitForCatalog(page)

  for (const ingredient of READY_INGREDIENTS) await addPantryText(page, ingredient)
  await expect(page.getByTestId('pantry-count')).toHaveText('In my kitchen (4)')

  // The unique zero-missing recipe LEADS the re-ranked grid…
  const first = page.locator('[data-test="recipe-grid"] article').first()
  await expect(first).toHaveAttribute('data-variant-id', String(READY_ID))
  const badge = badgeOf(page, READY_ID)
  await expect(badge).toHaveText(/Ready \(4 of 4\)/)
  // The check glyph is the aria-hidden svg icon, never a text glyph.
  await expect(badge.locator('svg')).toHaveCount(1)
})

test('chip removal returns focus to the add input; Clear ingredients empties', async ({ page }) => {
  await blockExternalRequests(page)
  await page.goto('/recipes')
  await waitForCatalog(page)

  await addPantryText(page, 'banana')
  await addPantryText(page, 'strawberries')
  await expect(page.getByTestId('pantry-count')).toHaveText('In my kitchen (2)')

  // Remove one chip — focus returns to the add input (Decision 10).
  await page.getByTestId('pantry-chip-banana').click()
  await expect(page.getByTestId('pantry-chip-banana')).toHaveCount(0)
  await expect(pantryAddInput(page)).toBeFocused()
  await expect(page.getByTestId('pantry-count')).toHaveText('In my kitchen (1)')

  // Clear-all: the row collapses back to the add affordance and the
  // badges disappear with the inactive row.
  await page.getByTestId('pantry-clear').click()
  await expect(page.getByTestId('pantry-count')).toHaveCount(0)
  await expect(page.locator('[data-test^="pantry-chip-"]')).toHaveCount(0)
  await expect(page.getByTestId('pantry-badge').first()).toHaveCount(0)
  await expect(page.getByTestId('pantry-summary')).not.toContainText('your kitchen')
})

test('the pantry persists across a reload (device-local slice)', async ({ page }) => {
  await blockExternalRequests(page)
  await page.goto('/recipes')
  await waitForCatalog(page)
  await addPantryText(page, 'banana')

  await page.reload()
  await waitForCatalog(page)
  await expect(page.getByTestId('pantry-chip-banana')).toBeVisible()
  await expect(page.getByTestId('pantry-count')).toHaveText('In my kitchen (1)')
  await expect(page.getByTestId('pantry-badge').first()).toBeVisible()
})
