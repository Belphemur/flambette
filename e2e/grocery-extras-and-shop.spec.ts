import { expect, test, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  blockExternalRequests,
  expectZeroMealimeRequests,
  gotoTab,
  openFirstRecipeDetail,
  waitForCatalog,
} from './helpers'
import { zipStore } from '../src/lib/zip'

/**
 * Phase 16: the grocery experience at its reference state —
 *  - Settings hosts backup & restore (moved from the Plan tab, ADR-0016),
 *  - EXTRA ITEMS renders first with per-item category TAGS (never routed,
 *    ADR-0015),
 *  - ShopView auto-collapses completed categories (ADR-0008 addendum).
 */

const input = (page: Page) => page.getByTestId('add-bar-input')
const firstRow = (page: Page) => page.locator('[data-test=add-suggestion-first]')

/** Plan one recipe so the grocery list has real store sections below EXTRA ITEMS. */
async function planFirstRecipe(page: Page): Promise<void> {
  await page.goto('/')
  await waitForCatalog(page)
  await openFirstRecipeDetail(page)
  await page.getByRole('dialog').getByRole('button', { name: 'Add to plan' }).click()
  await gotoTab(page, 'Grocery')
}

test.describe('Settings tab (data surface)', () => {
  test('five labelled tabs fit the bar at Pixel 7 width — no label is dropped', async ({ page }) => {
    await blockExternalRequests(page)
    await page.goto('/')
    await waitForCatalog(page)

    const nav = page.getByRole('navigation', { name: 'Main navigation' })
    for (const label of ['Recipes', 'Plan', 'Grocery', 'History', 'Settings'] as const) {
      await expect(nav.getByRole('button', { name: label })).toBeVisible()
    }

    // Every label stays inside its own tab button: no truncation, no
    // overflow, no icon-only fallback (ADR-0016 decision — measured at
    // Pixel 7: 410px row / 5 tabs = 82px per tab, widest label 49px).
    const fit = await page.evaluate(() => {
      const row = document.querySelector('nav[aria-label="Main navigation"]')!.firstElementChild!
      return Array.from(row.children).map((el) => {
        const button = el as HTMLElement
        const label = button.lastChild as Text
        const range = document.createRange()
        range.selectNode(label)
        return {
          label: label.textContent?.trim() ?? '',
          tabWidth: Math.round(button.getBoundingClientRect().width),
          labelWidth: Math.round(range.getBoundingClientRect().width),
          overflow: button.scrollWidth - button.clientWidth,
        }
      })
    })
    expect(fit).toHaveLength(5)
    for (const tab of fit) {
      expect(tab.label.length, `tab ${tab.label} kept its label`).toBeGreaterThan(0)
      expect(tab.overflow, `tab ${tab.label} does not overflow`).toBeLessThanOrEqual(0)
      expect(tab.labelWidth).toBeLessThan(tab.tabWidth)
    }
  })

  test('Settings hosts backup & restore; the Plan tab no longer renders the section', async ({ page }) => {
    await blockExternalRequests(page)
    await planFirstRecipe(page)

    // Plan tab: share surface only, no backup section.
    await gotoTab(page, 'Plan')
    await expect(page.getByTestId('export-settings')).toHaveCount(0)
    await expect(page.getByTestId('import-settings')).toHaveCount(0)
    await expect(page.getByText('Backup & restore')).toHaveCount(0)

    // Settings tab: both controls + the offline blurb.
    await gotoTab(page, 'Settings')
    await expect(page.getByText('Backup & restore')).toBeVisible()
    await expect(page.getByText('Works fully offline')).toBeVisible()
    await expect(page.getByTestId('export-settings')).toBeVisible()
    await expect(page.getByTestId('import-settings')).toBeVisible()

    // Deep link works too.
    await page.goto('/settings')
    await expect(page.getByTestId('export-settings')).toBeVisible()
  })

  test('export downloads a named backup zip and import restores it (toast "Backup restored")', async ({ page }) => {
    await blockExternalRequests(page)
    await planFirstRecipe(page)

    // Export → a suggested filename that the browser will accept.
    await gotoTab(page, 'Settings')
    const downloadPromise = page.waitForEvent('download')
    await page.getByTestId('export-settings').click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toMatch(/^mealime-planner-backup-\d{8}\.zip$/)
    const path = join(tmpdir(), `phase16-${Date.now()}.zip`)
    await download.saveAs(path)
    expect(existsSync(path)).toBe(true)

    // Import a valid backup built in-test → the restore toast fires.
    const buffer = Buffer.from(
      zipStore([
        {
          name: 'meta.json',
          data: new TextEncoder().encode(
            JSON.stringify({ app: 'mealime-planner', schema: 1, exportedAt: '2026-01-01T00:00:00Z' }),
          ),
        },
        {
          name: 'plan.json',
          data: new TextEncoder().encode(
            JSON.stringify({ entries: [], customItems: ['Restored item'], clearedIngredients: {} }),
          ),
        },
      ]),
    )
    await page.setInputFiles('[data-test=import-settings-input]', {
      name: 'mealime-planner-backup.zip',
      mimeType: 'application/zip',
      buffer,
    })
    await expect(page.getByRole('dialog', { name: 'Confirm backup restore' })).toBeVisible()
    await page.getByTestId('import-settings-confirm').click()
    await expect(page.getByTestId('toast')).toContainText('Backup restored')

    // The imported state is live on the Grocery tab.
    await gotoTab(page, 'Grocery')
    await expect(page.getByTestId('extra-section')).toContainText('Restored item')

    await expectZeroMealimeRequests(page)
  })
})

test.describe('EXTRA ITEMS with category tags (ADR-0015)', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page)
    await planFirstRecipe(page)
  })

  test('an extra with a known category gets a TAG and stays in EXTRA ITEMS (never routed)', async ({ page }) => {
    // Unknown name, explicit category pick (the ADR-0012 override select).
    await input(page).fill('Sunshade tent')
    await page.locator('[data-test=ingredient-category]').selectOption('Household')
    await page.locator('[data-test=ingredient-submit]').click()
    await expect(page.getByTestId('added-toast')).toContainText('Added to Household')

    const extra = page.getByTestId('extra-section')
    const row = extra.locator('li').filter({ hasText: 'Sunshade tent' })
    await expect(row).toHaveCount(1)

    // The category renders as a small tag pill, not a section header.
    await expect(row.locator('[data-test=extra-item-category-tag]')).toHaveText('#Household')
    // Header stays static (EXTRA ITEMS, no chevron/toggle).
    await expect(extra.getByRole('heading')).toHaveText(/Extra items/)
    await expect(extra.locator('[data-test=grocery-section-toggle]')).toHaveCount(0)

    // NOT routed: no Household store section exists, and the item is not in
    // any real section row.
    await expect(page.locator('[data-test=grocery-section]').filter({ hasText: 'Household' })).toHaveCount(0)
    await expect(page.locator('[data-test=grocery-row]').filter({ hasText: 'Sunshade tent' })).toHaveCount(0)

    // EXTRA ITEMS is the FIRST group on the tab: above Produce and every
    // other store section, with the add-row anchored under its header.
    const order = await page.evaluate(() => {
      const extra = document.querySelector('[data-test=extra-section]')!
      const firstSection = document.querySelector('[data-test=grocery-section]')
      const addBar = document.querySelector('[data-test=add-bar-input]')!
      const header = extra.querySelector('h3')!
      return {
        extraTop: extra.getBoundingClientRect().top + window.scrollY,
        firstSectionTop: firstSection
          ? firstSection.getBoundingClientRect().top + window.scrollY
          : Number.POSITIVE_INFINITY,
        addBarTop: addBar.getBoundingClientRect().top + window.scrollY,
        headerBottom: header.getBoundingClientRect().bottom + window.scrollY,
      }
    })
    expect(order.extraTop).toBeLessThan(order.firstSectionTop)
    // Add-row sits directly under the EXTRA ITEMS header.
    expect(order.addBarTop).toBeGreaterThan(order.headerBottom)
    expect(order.addBarTop - order.headerBottom).toBeLessThan(80)

    await expectZeroMealimeRequests(page)
  })

  test('an extra with no category stays a plain row — no tag, no section', async ({ page }) => {
    // Unknown name, no override → the "Other" bucket = unknown, not a tag.
    await input(page).fill('ziplock bags')
    await page.locator('[data-test=ingredient-submit]').click()
    await expect(page.getByTestId('added-toast')).toContainText('Added to Other')

    const extra = page.getByTestId('extra-section')
    const row = extra.locator('li').filter({ hasText: 'ziplock bags' })
    await expect(row).toHaveCount(1)
    await expect(row.locator('[data-test=extra-item-category-tag]')).toHaveCount(0)
    // The row is still the plain name + remove button.
    await expect(row.getByRole('button', { name: /Remove ziplock bags/ })).toBeVisible()
    await expect(page.locator('[data-test=grocery-section]').filter({ hasText: 'Other' })).toHaveCount(0)

    await expectZeroMealimeRequests(page)
  })

  test('an index-known extra (banana → Produce) is tagged, not moved into PRODUCE', async ({ page }) => {
    await input(page).fill('banana')
    await firstRow(page).click()
    await expect(page.getByTestId('added-toast')).toContainText('Added to Produce')

    const row = page.getByTestId('extra-section').locator('li').filter({ hasText: 'banana' })
    await expect(row.locator('[data-test=extra-item-category-tag]')).toHaveText('#Produce')
    // The real Produce section (from the planned recipe) is untouched: it
    // has no row for the extra and keeps only its recipe-derived lines.
    const produce = page.locator('[data-test=grocery-section]').filter({ hasText: 'Produce' }).first()
    await expect(produce).toBeVisible()
    await expect(produce.locator('[data-test=grocery-row]').filter({ hasText: 'banana' })).toHaveCount(0)
  })
})

test.describe('ShopView auto-collapse (ADR-0008 addendum)', () => {
  test('completing a category collapses it (header + N/N stay); unchecking re-expands', async ({ page }) => {
    await blockExternalRequests(page)
    await planFirstRecipe(page)
    await page.getByTestId('start-shopping').click()
    await expect(page.getByTestId('shopping-progress')).toBeVisible()

    // Work one category to completion: Produce (a Tuscan-kale soup plan
    // always has one), toggling every row via its header-scoped list.
    const produce = page.locator('[data-test=shop-section]').filter({ has: page.getByText('Produce', { exact: true }) })
    const rows = produce.locator('[data-test=shop-row]')
    const total = await rows.count()
    expect(total).toBeGreaterThan(0)

    for (let i = 0; i < total; i++) {
      // The sink re-sorts as we go, so always take the first NOT-checked row.
      const next = produce.locator('[data-test=shop-row]:not(.opacity-40)').first()
      await next.click()
      // Sink first, collapse last: the header still reads the running N/N.
      await expect(produce.getByTestId('section-count-pill')).toHaveText(`${i + 1}/${total}`)
    }

    // Auto-collapsed: rows gone, header + count pill + chevron remain.
    const toggle = produce.getByTestId('shop-section-toggle')
    await expect(produce.locator('[data-test=shop-row]')).toHaveCount(0)
    await expect(toggle).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(produce.getByTestId('section-count-pill')).toHaveText(`${total}/${total}`)
    await expect(toggle).toHaveAttribute('aria-label', `Produce: ${total} of ${total} checked`)
    await expect(toggle).toContainText('▸')

    // Other sections are untouched.
    await expect(page.locator('[data-test=shop-section]').locator('[data-test=shop-section-rows]').first()).toBeVisible()

    // Unchecking one line re-expands: open the group, drop a check.
    await toggle.click() // manual re-open keeps rows visible
    await expect(produce.locator('[data-test=shop-row]')).toHaveCount(total)
    await produce.locator('[data-test=shop-row].opacity-40').first().click()
    await expect(produce.getByTestId('section-count-pill')).toHaveText(`${total - 1}/${total}`)
    // Not done any more → the group stays expanded (auto state cleared).
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(produce.locator('[data-test=shop-row]')).toHaveCount(total)

    // Re-checking the last line collapses it again.
    await produce.locator('[data-test=shop-row]:not(.opacity-40)').first().click()
    await expect(produce.locator('[data-test=shop-row]')).toHaveCount(0)
    await expect(produce.getByTestId('section-count-pill')).toHaveText(`${total}/${total}`)

    await expectZeroMealimeRequests(page)
  })

  test('extra items stay manual-only in ShopView (no auto-collapse on a one-item extra)', async ({ page }) => {
    await blockExternalRequests(page)
    await planFirstRecipe(page)
    await input(page).fill('Sticky tape')
    await page.locator('[data-test=ingredient-submit]').click()
    await expect(page.getByTestId('extra-section')).toContainText('Sticky tape')

    await page.getByTestId('start-shopping').click()
    const extras = page.getByTestId('shop-custom-items')
    await expect(extras.locator('[data-test=shop-row]')).toHaveCount(1)
    await extras.locator('[data-test=shop-row]').click()
    // The whole list is now done, but the extra group does NOT auto-collapse.
    await expect(extras.locator('[data-test=shop-row]')).toHaveCount(1)
    await expect(extras.getByTestId('shop-section-toggle')).toHaveAttribute('aria-expanded', 'true')

    // Manual collapse still works.
    await extras.getByTestId('shop-section-toggle').click()
    await expect(extras.locator('[data-test=shop-row]')).toHaveCount(0)
  })
})
