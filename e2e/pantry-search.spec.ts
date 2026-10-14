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

/** The "Cook With Your Pantry" active-state heading (Addendum §2). */
function pantryHeading(page: Page) {
  return page.getByTestId('pantry-heading')
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
  await expect(pantryHeading(page)).toHaveCount(0)

  // The row (with the Addendum-n widened add input) never overflows the
  // filter bar on phones (the ADR-0049 tooltip overflow class of bug).
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)

  // Addendum notes: the add input widens on desktop (sm:w-72, lg:w-96);
  // phones keep the full-width pill.
  const width = (await page.viewportSize())?.width ?? 1280
  const addWidth = (await pantryAddInput(page).boundingBox())?.width ?? 0
  if (width >= 1024) expect(addWidth).toBeGreaterThanOrEqual(380)
  else if (width >= 640) expect(addWidth).toBeGreaterThanOrEqual(280)
  else expect(addWidth).toBeLessThanOrEqual(width)
})

test('add → chip → grid filters, re-ranks and badges; offline is kept', async ({ page }) => {
  await blockExternalRequests(page)
  await page.goto('/recipes')
  await waitForCatalog(page)

  // The first add collapses the row open: chip, count label, summary.
  await addPantryText(page, 'banana')
  await expect(page.getByTestId('pantry-chip-banana')).toBeVisible()
  await expect(page.getByTestId('pantry-count')).toHaveText('In my kitchen (1)')
  // Addendum §2: the active-state heading leads the summary, then the
  // real matching count, then the aria-live status text.
  await expect(pantryHeading(page)).toHaveText('Cook With Your Pantry · ')
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

test("the owner's case: 'cherry tomatoes' reaches the name-only recipes (Addendum §1)", async ({ page }) => {
  await blockExternalRequests(page)
  await page.goto('/recipes')
  await waitForCatalog(page)

  // NO variant lists `cherry tomatoes` under ingredient_names (the
  // taxonomy uses grape tomatoes / tomato / diced tomatoes) — before the
  // Addendum this pantry chip matched nothing at all.
  await addPantryText(page, 'cherry tomatoes')
  await expect(pantryHeading(page)).toHaveText('Cook With Your Pantry · ')
  await expect(page.getByTestId('pantry-summary')).toContainText(/match your kitchen/)

  // The Tuscan variant carries the words only in its NAME — it must now
  // be in the filtered grid, READY for the whole pantry (Ready (1 of 1)).
  const TUSCAN_ID = 9883
  const card = page.locator(`article[data-variant-id="${TUSCAN_ID}"]`)
  await expect(card).toBeVisible()
  await expect(card.getByTestId('pantry-badge')).toHaveText(/Ready \(1 of 1\)/)
})
