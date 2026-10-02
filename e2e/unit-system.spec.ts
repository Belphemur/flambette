import { expect, test } from '@playwright/test'
import {
  blockExternalRequests,
  expectZeroMealimeRequests,
  gotoTab,
  waitForCatalog,
} from './helpers'

/**
 * ADR-0047 — the unit system.
 *
 * Every assertion here runs against a fixture chosen from the frozen
 * catalog, not a hand-written fake: "Baked Gremolata-Crusted Cod with
 * Potatoes, Zucchini, Peppers & Olives" (variant 26886) is authored
 * `1.02 kg` twice and opens with `Preheat the oven to 220°C (425°F).`, so
 * one recipe covers the quantity, the container-free mass and the
 * dual-notation temperature in a single sheet. It is deep-linked, so the
 * spec never depends on where the paginated grid happens to rank it.
 */
const VARIANT_ID = 26886

/** The detail sheet is a dialog; its ingredients and steps live inside it. */
function sheet(page: import('@playwright/test').Page) {
  return page.getByRole('dialog')
}

async function openFixture(page: import('@playwright/test').Page) {
  await page.goto(`/recipe/${VARIANT_ID}`)
  await expect(sheet(page)).toBeVisible({ timeout: 15_000 })
}

async function planFixture(page: import('@playwright/test').Page): Promise<void> {
  await openFixture(page)
  await sheet(page).getByRole('button', { name: 'Add to plan' }).click()
}

/** The grocery row for one ingredient of the fixture. */
function groceryRow(page: import('@playwright/test').Page, name: string) {
  return page.locator('main').getByTestId('grocery-row').filter({ hasText: name })
}

test.beforeEach(async ({ page }) => {
  await blockExternalRequests(page)
  await page.goto('/')
  await waitForCatalog(page)
})

test('DUAL is the default: the authored text, verbatim', async ({ page }) => {
  await openFixture(page)
  // The catalog's own `220°C (425°F)` is what a dual reader gets, byte for
  // byte — the default must not churn a single pre-existing display pin.
  await expect(sheet(page).getByText('Preheat the oven to 220°C (425°F).')).toBeVisible()
  await expect(sheet(page).getByText('1.02 kg').first()).toBeVisible()
  await expect(page.getByTestId('detail-unit-dual')).toHaveAttribute('aria-pressed', 'true')
  // The toggle speaks the Settings card's grammar: three SYSTEMS, not three
  // unit pairs. `°C/°F` used to sit on this button and it is not an option.
  for (const label of ['Dual', 'Metric', 'Imperial']) {
    await expect(page.getByTestId('detail-unit-toggle').getByRole('button', { name: `${label} units` })).toBeVisible()
  }
  await expect(page.getByTestId('detail-unit-toggle')).not.toContainText('°')
  await expectZeroMealimeRequests(page)
})

test('METRIC collapses the dual notation to °C and leaves metric amounts alone', async ({ page }) => {
  await openFixture(page)
  await page.getByTestId('detail-unit-toggle').getByRole('button', { name: 'Metric units' }).click()
  await expect(sheet(page).getByText('Preheat the oven to 220°C.')).toBeVisible()
  await expect(sheet(page).getByText(/425°F/)).toHaveCount(0)
  // A metric quantity is the IDENTITY — no rounding churn on the sheet.
  await expect(sheet(page).getByText('1.02 kg').first()).toBeVisible()
  await expect(page.getByTestId('detail-unit-metric')).toHaveAttribute('aria-pressed', 'true')
  await expectZeroMealimeRequests(page)
})

test('a cup gains its volume in a single-system mode and stays authored in dual', async ({ page }) => {
  // `cup` is a purchasable VOLUME container: the count never converts, the
  // mode's volume is annotated next to it (US legal cup = 240 ml exactly).
  await openFixture(page)
  await page.getByTestId('detail-unit-toggle').getByRole('button', { name: 'Metric units' }).click()
  await expect(sheet(page).getByText('1 cup (240 ml)').first()).toBeVisible()
  await sheet(page).getByRole('button', { name: 'Back' }).click()
  await openFixture(page)
  await page.getByTestId('detail-unit-toggle').getByRole('button', { name: 'Dual units' }).click()
  await expect(sheet(page).getByText('1 cup', { exact: false }).first()).toBeVisible()
  await expect(sheet(page).getByText('1 cup (240 ml)')).toHaveCount(0)
  await expectZeroMealimeRequests(page)
})

test('the settings card flips a grocery line and a recipe ingredient to imperial', async ({ page }) => {
  await planFixture(page)
  await sheet(page).getByRole('button', { name: 'Back' }).click()

  await gotoTab(page, 'Settings')
  await page.getByTestId('unit-system-imperial').click()
  await expect(page.getByTestId('unit-system-imperial')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('unit-system-metric')).toHaveAttribute('aria-pressed', 'false')

  // The grocery line converts for display: 1 kg → 2.2 lb (the aggregated
  // line is `formatAmount`-rounded, so it reads `1 kg` in metric).
  await gotoTab(page, 'Grocery')
  const codRow = groceryRow(page, 'cod fillet')
  await expect(codRow).toBeVisible({ timeout: 10_000 })
  await expect(codRow.getByText('2.2 lb')).toBeVisible()
  await expect(codRow.getByText('1 kg')).toHaveCount(0)

  // …and so does the recipe sheet.
  await openFixture(page)
  await expect(sheet(page).getByText('2.2 lb').first()).toBeVisible()
  await expectZeroMealimeRequests(page)
})

test('the recipe-detail toggle flips a step temperature to °F and is the SAME setting', async ({ page }) => {
  await openFixture(page)
  await page.getByTestId('detail-unit-toggle').getByRole('button', { name: 'Imperial units' }).click()
  await expect(sheet(page).getByText('Preheat the oven to 425°F.')).toBeVisible()
  await expect(sheet(page).getByText(/220°C/)).toHaveCount(0)

  // One setting, two affordances: the Settings card reads imperial too.
  await sheet(page).getByRole('button', { name: 'Back' }).click()
  await gotoTab(page, 'Settings')
  await expect(page.getByTestId('unit-system-imperial')).toHaveAttribute('aria-pressed', 'true')
  await expectZeroMealimeRequests(page)
})

test('the choice survives a reload', async ({ page }) => {
  await planFixture(page)
  await sheet(page).getByRole('button', { name: 'Back' }).click()

  await gotoTab(page, 'Settings')
  await page.getByTestId('unit-system-imperial').click()
  await expect(page.getByTestId('unit-system-imperial')).toHaveAttribute('aria-pressed', 'true')

  await page.reload()
  await gotoTab(page, 'Settings')
  await expect(page.getByTestId('unit-system-imperial')).toHaveAttribute('aria-pressed', 'true')

  await gotoTab(page, 'Grocery')
  const codRow = groceryRow(page, 'cod fillet')
  await expect(codRow.getByText('2.2 lb')).toBeVisible({ timeout: 10_000 })
  await expectZeroMealimeRequests(page)
})

test('a checked item stays checked across a unit-system toggle', async ({ page }) => {
  await planFixture(page)
  await sheet(page).getByRole('button', { name: 'Back' }).click()

  await gotoTab(page, 'Grocery')
  const progress = page.locator('main').getByText(/\d+ \/ \d+ items/)
  await expect(progress).toBeVisible({ timeout: 10_000 })
  const total = (await progress.textContent())!.match(/(\d+) items/)![1]

  // `new potatoes` is a CONVERTED line (1 kg → 2.2 lb) inside a section
  // with six other items, so checking it does not collapse the group away
  // (ADR-0008) and the checkbox stays observable.
  const potatoes = groceryRow(page, 'new potatoes')
  await potatoes.locator('input[type="checkbox"]').check()
  await expect(progress).toHaveText(`1 / ${total} items`)

  // The canonical key basis is untouched by the display transform, so the
  // check cannot be orphaned by a toggle.
  await gotoTab(page, 'Settings')
  await page.getByTestId('unit-system-imperial').click()
  await gotoTab(page, 'Grocery')
  await expect(progress).toHaveText(`1 / ${total} items`)
  const imperialPotatoes = groceryRow(page, 'new potatoes')
  await expect(imperialPotatoes.getByText('2.2 lb')).toBeVisible()
  await expect(imperialPotatoes.locator('input[type="checkbox"]')).toBeChecked()
  await expectZeroMealimeRequests(page)
})
