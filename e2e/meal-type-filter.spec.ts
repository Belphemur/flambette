import { expect, test, type Page } from '@playwright/test'
import {
  blockExternalRequests,
  expectZeroMealimeRequests,
  gotoTab,
  waitForCatalog,
} from './helpers'

/**
 * The Meal type dropdown (ADR-0043) — Breakfast / Dessert / Snack / Simple
 * / Dinner, fed entirely by the catalog's own `ruleset` field.
 *
 * The interesting property here is that this filter is EXACT: it is a
 * string compare against data Mealime already ships, not a keyword lens
 * like the diet chips (ADR-0018). So the assertions are arithmetic — the
 * count on an option, the number of results it produces, and the two
 * agreeing with each other and with the served catalog. A catalog sync
 * legitimately moves these numbers, so the specs read the truth from
 * `builder_data.json` and check the CONSISTENCY rather than pinning
 * literals that only a human could update.
 */

test.beforeEach(async ({ page }) => {
  await blockExternalRequests(page)
  await page.goto('/')
  await waitForCatalog(page)
  await gotoTab(page, 'Recipes')
})

/** The Recipes tab's result-count paragraph. */
function resultCount(page: Page) {
  return page.locator('p', { hasText: /\d+ recipes?/ })
}

/**
 * How many feasible variants the served catalog holds per `ruleset` —
 * the same tally scripts/extract_recipe_types.py froze into
 * recipe_types.json. Read from the served artifact so a catalog sync
 * fails a consistency check rather than a hard-coded number.
 */
async function rulesetCounts(page: Page): Promise<Record<string, number>> {
  return page.evaluate(async () => {
    const data = await fetch('/data/builder_data.json').then((r) => r.json())
    const feasible = new Set<number>(data.feasible_variants as number[])
    const counts: Record<string, number> = {}
    for (const meta of data.variant_meta as { id: number; ruleset: string }[]) {
      if (!feasible.has(meta.id)) continue
      counts[meta.ruleset] = (counts[meta.ruleset] ?? 0) + 1
    }
    return counts
  })
}

async function catalogSize(page: Page): Promise<number> {
  const counts = await rulesetCounts(page)
  return Object.values(counts).reduce((a, b) => a + b, 0)
}

async function expectResultCount(page: Page, n: number) {
  // The tab renders `{{ results.length }}` raw — no thousands separator —
  // so the expectation matches that, and a count of 2119 is asserted as
  // "2119 recipes", never "2,119".
  await expect(resultCount(page)).toContainText(`${n} recipes`, { timeout: 15_000 })
}

/** Open the dropdown and return its listbox. */
async function openMenu(page: Page) {
  const trigger = page.getByTestId('mealtype-button')
  await expect(trigger).toBeVisible()
  await trigger.click()
  const menu = page.getByTestId('mealtype-menu')
  await expect(menu).toBeVisible()
  return menu
}

test('the dropdown offers the five meals with the counts the catalog gives', async ({ page }) => {
  const counts = await rulesetCounts(page)

  // The closed trigger is the neutral "Any" state: an occasion is not a
  // food, so it carries no hue, and nothing is filtered yet.
  const trigger = page.getByTestId('mealtype-button')
  await expect(trigger).toBeVisible()
  await expect(trigger).toContainText('Any')
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  await expect(trigger).toHaveAttribute('aria-haspopup', 'listbox')

  const menu = await openMenu(page)
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')

  // Every option's badge is the build-time count from the committed
  // table — not a scan the client ran to paint a number.
  for (const [label, ruleset] of [
    ['Breakfast', 'breakfast'],
    ['Dessert', 'dessert'],
    ['Snack', 'snack'],
    ['Simple', 'simple'],
    ['Dinner', 'dinner'],
  ] as const) {
    await expect(menu.getByTestId(`mealtype-option-${label}`)).toContainText(
      String(counts[ruleset]),
    )
  }
  // `cpg` is counted for partition parity but is not a meal anyone plans
  // around, so it is never offered.
  await expect(menu.getByTestId('mealtype-option-Branded')).toHaveCount(0)
  // The buckets partition the catalog: no variant falls through.
  const offered = Object.entries(counts)
    .filter(([r]) => r !== 'cpg')
    .reduce((n, [, c]) => n + c, 0)
  expect(offered + (counts.cpg ?? 0)).toBe(await catalogSize(page))
  await expectZeroMealimeRequests(page)
})

test('picking a meal type narrows to exactly that ruleset, and Any gives it all back', async ({ page }) => {
  const counts = await rulesetCounts(page)

  await openMenu(page)
  await page.getByTestId('mealtype-option-Dessert').click()
  await expect(page.getByTestId('mealtype-menu')).toHaveCount(0)
  // Selecting narrows the grid to the catalog's own number for that
  // bucket — the whole point of an exact facet.
  await expectResultCount(page, counts.dessert)
  // The closed trigger now names the choice (icon + label, no hue).
  await expect(page.getByTestId('mealtype-button')).toContainText('Dessert')
  await expect(page.getByTestId('mealtype-button')).toHaveAttribute('aria-expanded', 'false')

  // A different bucket REPLACES it: one occasion at a time.
  await openMenu(page)
  await page.getByTestId('mealtype-option-Breakfast').click()
  await expectResultCount(page, counts.breakfast)
  await expect(page.getByTestId('mealtype-button')).toContainText('Breakfast')

  // Any clears it, and the unfiltered total is the whole catalog.
  await openMenu(page)
  await page.getByTestId('mealtype-option-Any').click()
  await expectResultCount(page, await catalogSize(page))
  await expect(page.getByTestId('mealtype-button')).toContainText('Any')
  await expectZeroMealimeRequests(page)
})

test('a meal type is household state: it persists across a reload', async ({ page }) => {
  const counts = await rulesetCounts(page)

  await openMenu(page)
  await page.getByTestId('mealtype-option-Dessert').click()
  await expectResultCount(page, counts.dessert)

  await page.reload()
  await waitForCatalog(page)
  await gotoTab(page, 'Recipes')
  // One object, one persisted slice (ADR-0027): the selection rides the
  // existing `mealime-planner:v1:ui` key, with no new store entry.
  await expect(page.getByTestId('mealtype-button')).toContainText('Dessert')
  await expectResultCount(page, counts.dessert)

  // …and "Clear filters" resets it with everything else.
  await page.getByRole('button', { name: 'Clear filters' }).click()
  await expect(page.getByTestId('mealtype-button')).toContainText('Any')
  await expectResultCount(page, await catalogSize(page))
  await expectZeroMealimeRequests(page)
})

test('the dropdown is keyboard-operable and Escape returns focus to its trigger', async ({ page }) => {
  const trigger = page.getByTestId('mealtype-button')
  await trigger.focus()
  await page.keyboard.press('Enter')

  const menu = page.getByTestId('mealtype-menu')
  await expect(menu).toBeVisible()
  // The listbox opens on the ACTIVE option (Any), not on the first
  // arbitrary row.
  await expect(menu.getByTestId('mealtype-option-Any')).toBeFocused()

  await page.keyboard.press('ArrowDown')
  await expect(menu.getByTestId('mealtype-option-Breakfast')).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(menu.getByTestId('mealtype-option-Dessert')).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(menu.getByTestId('mealtype-option-Breakfast')).toBeFocused()

  // Escape closes the popup and hands focus back, so the cook is never
  // dropped at the top of the document.
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(trigger).toBeFocused()

  // Enter on a focused option selects it and closes, same as a click.
  await page.keyboard.press('Enter')
  await expect(menu).toBeVisible()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(menu).toHaveCount(0)
  await expect(trigger).toContainText('Breakfast')
  await expectZeroMealimeRequests(page)
})

test('a meal type combines with the other filters by AND, and narrows further', async ({ page }) => {
  const counts = await rulesetCounts(page)

  await openMenu(page)
  await page.getByTestId('mealtype-option-Simple').click()
  await expectResultCount(page, counts.simple)

  // A diet chip on top can only ever REMOVE recipes (ADR-0018 diets AND
  // with the exact facet) — never add any.
  await page.getByTestId('diet-chip-vegetarian').click()
  const narrowed = await resultCount(page).textContent()
  const n = Number(narrowed!.match(/(\d+) recipes?/)![1])
  expect(n).toBeLessThanOrEqual(counts.simple)
  expect(n).toBeGreaterThan(0)
  await expectZeroMealimeRequests(page)
})
