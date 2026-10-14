import { expect, test, type Page } from '@playwright/test'
import {
  blockExternalRequests,
  expectZeroMealimeRequests,
  waitForCatalog,
} from './helpers'

/**
 * The "Kitchen" filter dropdown (ADR-0089) — the pantry as a chip in the
 * filter row, with its In-My-Kitchen panel. Covers:
 *  - the collapsed-by-default state: the chip renders INACTIVE (no count
 *    badge, chevron down) and the panel is CLOSED; default browse is
 *    unchanged;
 *  - open via the chip, close via Escape AND via an outside click;
 *  - add → chip appears in the panel → the grid filters to ≥1-overlap
 *    recipes, re-ranks ascending by missing count (ADR-0087 Decision 4)
 *    and cards carry the pantry badge (Decision 6), on both grammars
 *    (desktop / mobile compact) across the two projects;
 *  - chip removal returns focus to the add input (Decision 10);
 *  - Clear all empties the pantry;
 *  - the Ready (N of N) state with the check glyph;
 *  - the matching-count summary + aria-live status (Decision 6b);
 *  - one count source: the trigger badge and the panel "N items" badge
 *    read the same number;
 *  - the pantry survives a reload (device-local persisted slice,
 *    Decision 7);
 *  - the row-overflow pin (document scrollWidth ≤ clientWidth) holds
 *    with the Kitchen chip present AND with the panel open on phones
 *    (the ADR-0049 overflow class of bug);
 *  - offline enforcement keeps passing.
 */

/** Real data, computed from the served builder_data with the app's own
 *  nameKey rule: this 4-ingredient recipe is the ONLY recipe READY for
 *  its full pantry set below, and with garlic added instead it reads
 *  "Needs 1 more: garlic". */
const READY_ID = 7467
const READY_INGREDIENTS = ['banana', 'strawberries', 'large flour tortilla', 'natural peanut butter']
const NEEDS_ONE_ID = 7028 // Strawberry Banana Greek Yogurt Smoothie

/** The trigger chip (the retired row's hook is now the whole dropdown
 *  wrapper; the trigger button is its own hook). */
function pantryTrigger(page: Page) {
  return page.getByTestId('pantry-trigger')
}

function pantryPanel(page: Page) {
  return page.getByTestId('pantry-panel')
}

function pantryAddInput(page: Page) {
  return page.getByTestId('pantry-add-input')
}

/** The full flow to add by raw text: open the dropdown, type, Enter. */
async function addPantryText(page: Page, name: string) {
  await pantryTrigger(page).click()
  await expect(pantryPanel(page)).toBeVisible()
  await pantryAddInput(page).fill(name)
  await pantryAddInput(page).press('Enter')
  // Close for the next call; the grid behind is re-ranked either way.
  await pantryTrigger(page).click()
  await expect(pantryPanel(page)).toBeHidden()
}

/** Add several ingredients, one dropdown round-trip each. */
async function addPantryItems(page: Page, names: string[]) {
  for (const name of names) await addPantryText(page, name)
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

test('the Kitchen chip renders inactive with the panel closed by default', async ({ page }) => {
  await blockExternalRequests(page)
  await page.goto('/recipes')
  await waitForCatalog(page)

  // The chip is visible and INACTIVE: no count badge while the pantry
  // is empty, and the panel is closed (not mounted).
  await expect(page.getByTestId('pantry-row')).toBeVisible()
  await expect(pantryTrigger(page)).toBeVisible()
  await expect(page.getByTestId('pantry-trigger-badge')).toHaveCount(0)
  await expect(pantryTrigger(page)).toHaveAttribute('aria-expanded', 'false')
  await expect(pantryPanel(page)).toHaveCount(0)
  await expect(page.locator('[data-test^="pantry-chip-"]')).toHaveCount(0)
  await expect(page.getByTestId('pantry-clear')).toHaveCount(0)
  // The grid header keeps its plain count text while inactive.
  await expect(page.getByTestId('pantry-summary')).not.toContainText('your kitchen')
  await expect(pantryHeading(page)).toHaveCount(0)

  // The filter row (WITH the Kitchen chip present) never overflows the
  // page on phones (the ADR-0049 tooltip overflow class of bug).
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
})

test('opening the chip reveals the panel; Escape and outside click close it', async ({ page }) => {
  await blockExternalRequests(page)
  await page.goto('/recipes')
  await waitForCatalog(page)

  await pantryTrigger(page).click()
  await expect(pantryPanel(page)).toBeVisible()
  await expect(pantryTrigger(page)).toHaveAttribute('aria-expanded', 'true')
  // The panel header with the count badge ("0 items") and Clear all.
  await expect(page.getByTestId('pantry-clear')).toBeVisible()
  // The add input is the panel's focal element.
  await expect(pantryAddInput(page)).toBeVisible()

  // The open panel (its left-anchored width on phones) must not make
  // the DOCUMENT horizontally scrollable.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)

  // Escape closes the panel and refocuses the trigger.
  await page.keyboard.press('Escape')
  await expect(pantryPanel(page)).toHaveCount(0)
  await expect(pantryTrigger(page)).toBeFocused()

  // Outside click closes it too: the neighbouring cook-time trigger
  // sits in the SAME row as the Kitchen chip, so the panel (which only
  // covers the band BELOW the chip row) never covers it. Its own menu
  // opening afterwards is harmless.
  await pantryTrigger(page).click()
  await expect(pantryPanel(page)).toBeVisible()
  await page.getByTestId('cook-time-filter').click()
  await expect(pantryPanel(page)).toHaveCount(0)
})

test('add → chip → grid filters, re-ranks and badges; offline is kept', async ({ page }) => {
  await blockExternalRequests(page)
  await page.goto('/recipes')
  await waitForCatalog(page)

  // The first add activates the chip: count badge, then the summary.
  await addPantryItems(page, ['banana'])
  await expect(page.getByTestId('pantry-trigger-badge')).toHaveText('1')
  // Addendum §2: the active-state heading leads the summary, then the
  // real matching count, then the aria-live status text.
  await expect(pantryHeading(page)).toHaveText('Cook With Your Pantry · ')
  await expect(page.getByTestId('pantry-summary')).toContainText(/recipes match your kitchen/)

  // The badge only exists while the pantry is active — and now it does.
  await expect(page.getByTestId('pantry-badge').first()).toBeVisible()

  // Three more pantry items, one of which (garlic) the strawberry
  // smoothie does NOT use: its badge names the ONE missing ingredient.
  await addPantryItems(page, ['strawberries', 'whole milk', 'garlic'])
  await expect(page.getByTestId('pantry-trigger-badge')).toHaveText('4')
  const width = (await page.viewportSize())?.width ?? 1280
  const needsOne =
    width >= 1024
      ? 'You have 3 of 4 · Needs 1 more: garlic'
      : '3 of 4 • Needs 1'
  await expect(visibleBadgeSpan(page, NEEDS_ONE_ID)).toHaveText(needsOne)

  // The aria-live status carries the same count sentence the header shows.
  await expect(page.getByTestId('pantry-summary')).toHaveAttribute('aria-live', 'polite')

  // One count source: the panel's "N items" badge reads the same
  // number as the trigger badge.
  await pantryTrigger(page).click()
  await expect(pantryPanel(page)).toBeVisible()
  const panelBadge = pantryPanel(page).locator('span', { hasText: /^4 items?$/ })
  await expect(panelBadge).toBeVisible()
  await page.keyboard.press('Escape')

  // Zero-mealime-host requests: the feature is fully offline.
  await expectZeroMealimeRequests(page)
})

test('suggestions already in the pantry render "Active in kitchen"', async ({ page }) => {
  await blockExternalRequests(page)
  await page.goto('/recipes')
  await waitForCatalog(page)

  await addPantryItems(page, ['banana'])
  await pantryTrigger(page).click()
  await expect(pantryPanel(page)).toBeVisible()

  // Typing the pantry ingredient again: the typed raw-text row is
  // omitted, the index suggestion carries the active state.
  await pantryAddInput(page).fill('banan')
  const activeRow = page.getByTestId('pantry-suggestion-active').first()
  await expect(activeRow).toBeVisible()
  await expect(activeRow).toHaveText('Active in kitchen')

  // Clicking the active row is a no-op: no second chip, input kept.
  const rows = page.getByRole('option', { name: /already in your kitchen/ })
  await rows.first().click()
  await expect(page.getByTestId('pantry-chip-banana')).toHaveCount(1)
  await expect(pantryAddInput(page)).toHaveValue('banan')
})

test('badge reaches the Ready (N of N) state with the check glyph', async ({ page }) => {
  await blockExternalRequests(page)
  await page.goto('/recipes')
  await waitForCatalog(page)

  await addPantryItems(page, READY_INGREDIENTS)
  await expect(page.getByTestId('pantry-trigger-badge')).toHaveText('4')

  // The unique zero-missing recipe LEADS the re-ranked grid…
  const first = page.locator('[data-test="recipe-grid"] article').first()
  await expect(first).toHaveAttribute('data-variant-id', String(READY_ID))
  const badge = badgeOf(page, READY_ID)
  await expect(badge).toHaveText(/Ready \(4 of 4\)/)
  // The check glyph is the aria-hidden svg icon, never a text glyph.
  await expect(badge.locator('svg')).toHaveCount(1)
})

test('chip removal returns focus to the add input; Clear all empties', async ({ page }) => {
  await blockExternalRequests(page)
  await page.goto('/recipes')
  await waitForCatalog(page)

  await addPantryItems(page, ['banana', 'strawberries'])
  await expect(page.getByTestId('pantry-trigger-badge')).toHaveText('2')

  // Open the panel and remove one chip — focus returns to the add
  // input (Decision 10).
  await pantryTrigger(page).click()
  await expect(pantryPanel(page)).toBeVisible()
  await page.getByTestId('pantry-chip-banana').click()
  await expect(page.getByTestId('pantry-chip-banana')).toHaveCount(0)
  await expect(pantryAddInput(page)).toBeFocused()
  await expect(page.getByTestId('pantry-trigger-badge')).toHaveText('1')

  // Clear-all: the panel keeps living (input + footer), the count
  // surfaces drop to zero, and the badges disappear with the inactive
  // pantry.
  await page.getByTestId('pantry-clear').click()
  await expect(page.getByTestId('pantry-trigger-badge')).toHaveCount(0)
  await expect(page.locator('[data-test^="pantry-chip-"]')).toHaveCount(0)
  await expect(page.getByTestId('pantry-badge').first()).toHaveCount(0)
  await expect(page.getByTestId('pantry-summary')).not.toContainText('your kitchen')
  await expect(pantryAddInput(page)).toBeFocused()
})

test('the pantry persists across a reload (device-local slice)', async ({ page }) => {
  await blockExternalRequests(page)
  await page.goto('/recipes')
  await waitForCatalog(page)
  await addPantryItems(page, ['banana'])

  await page.reload()
  await waitForCatalog(page)
  await expect(page.getByTestId('pantry-trigger-badge')).toHaveText('1')
  await expect(page.getByTestId('pantry-badge').first()).toBeVisible()
  // The chip lives in the panel; opening it shows the persisted entry.
  await pantryTrigger(page).click()
  await expect(page.getByTestId('pantry-chip-banana')).toBeVisible()
})

test("the owner's case: 'cherry tomatoes' reaches the name-only recipes (Addendum §1)", async ({ page }) => {
  await blockExternalRequests(page)
  await page.goto('/recipes')
  await waitForCatalog(page)

  // NO variant lists `cherry tomatoes` under ingredient_names (the
  // taxonomy uses grape tomatoes / tomato / diced tomatoes) — before
  // the Addendum this pantry chip matched nothing at all. The flow is
  // now: open the Kitchen chip → type → add → grid filters.
  await pantryTrigger(page).click()
  await expect(pantryPanel(page)).toBeVisible()
  await pantryAddInput(page).fill('cherry tomatoes')
  await pantryAddInput(page).press('Enter')
  // nameKey folds the plural: 'cherry tomatoes' → 'cherry tomato'
  // (keys keep the folded words' spaces — the pantry-chip-<nameKey>
  // hook is built from the key verbatim).
  await expect(page.getByTestId('pantry-chip-cherry tomato')).toBeVisible()
  // Leave the panel open — the grid behind re-ranks live.
  await expect(pantryHeading(page)).toHaveText('Cook With Your Pantry · ')
  await expect(page.getByTestId('pantry-summary')).toContainText(/match your kitchen/)

  // The Tuscan variant carries the words only in its NAME — it must now
  // be in the filtered grid, READY for the whole pantry (Ready (1 of 1)).
  const TUSCAN_ID = 9883
  const card = page.locator(`article[data-variant-id="${TUSCAN_ID}"]`)
  await expect(card).toBeVisible()
  await expect(card.getByTestId('pantry-badge')).toHaveText(/Ready \(1 of 1\)/)
})
