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
    await expect(page.getByTestId('custom-items')).toContainText('Restored item')

    await expectZeroMealimeRequests(page)
  })
})
