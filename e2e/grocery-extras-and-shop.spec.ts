import { expect, test, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  blockExternalRequests,
  expectZeroMealimeRequests,
  gotoTab,
  openFirstRecipeDetail,
  pickCategoryOverride,
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
  await page.goto('/recipes')
  await waitForCatalog(page)
  await openFirstRecipeDetail(page)
  await page.getByRole('dialog').getByRole('button', { name: 'Add to plan' }).click()
  await gotoTab(page, 'Grocery')
}

test.describe('Settings tab (data surface)', () => {
  test('five labelled tabs fit the bar at Pixel 7 width — no label is dropped', async ({ page }) => {
    await blockExternalRequests(page)
    await page.goto('/recipes')
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

test.describe('EXTRA ITEMS sub-sectioned by category (ADR-0050)', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page)
    await planFirstRecipe(page)
  })

  test('an extra with a known category gets its OWN sub-section and stays in EXTRA ITEMS (never routed)', async ({ page, isMobile }) => {
    // Unknown name, explicit category pick (the ADR-0012 override dropdown,
    // now the shared FilterDropdown per ADR-0050 §8).
    await input(page).fill('Sunshade tent')
    await pickCategoryOverride(page, 'Household')
    await page.locator('[data-test=ingredient-submit]').click()
    await expect(page.getByTestId('added-toast')).toContainText('Added to Household')

    const extra = page.getByTestId('extra-section')
    const subsection = extra.locator('[data-test=extra-subsection]').filter({ has: page.getByRole('button', { name: /^Household:/ }) })
    const row = subsection.locator('li').filter({ hasText: 'Sunshade tent' })
    await expect(row).toHaveCount(1)

    // The category is the sub-section heading, not a per-row pill: ADR-0050
    // §7 removed `extra-item-category-tag` because the heading directly
    // above the row says the same thing.
    await expect(subsection.locator('[data-test=extra-item-category-tag]')).toHaveCount(0)
    await expect(subsection.getByTestId('extra-subsection-toggle')).toHaveAttribute('aria-expanded', 'true')
    await expect(subsection.getByTestId('extra-subsection-toggle')).toHaveAttribute('aria-label', 'Household: 0 of 1 checked')
    await expect(subsection.getByTestId('section-count-pill')).toHaveText('0/1')
    // The GROUP header stays static (no chevron/toggle) — only the
    // sub-section headers below it collapse (re-scoped by ADR-0050 §1).
    await expect(extra.getByRole('heading', { name: 'Extra items' })).toBeVisible()
    await expect(extra.locator('> h3 button')).toHaveCount(0)
    await expect(extra.locator('> h3 svg')).toHaveCount(0)

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
    // The add-row is anchored to the extras group, but WHERE depends on the
    // breakpoint (ADR-0071 delta 4): phones keep it directly under the
    // group header; desktop relocates it into the sidebar's Quick Extra
    // Entry. Either way it belongs to the extras group, never to a store
    // section.
    if (isMobile) {
      expect(order.addBarTop).toBeGreaterThan(order.headerBottom)
      expect(order.addBarTop - order.headerBottom).toBeLessThan(80)
    } else {
      await expect(page.getByTestId('grocery-sidebar')).toContainText('Quick extra entry')
      await expect(page.getByTestId('extra-section').getByTestId('add-bar-input')).toHaveCount(0)
    }

    await expectZeroMealimeRequests(page)
  })

  test('an extra with no category collects in the Uncategorized bucket', async ({ page }) => {
    // Unknown name, no override → the "Other" bucket = unknown. It is no
    // longer a flat unlabelled row: ADR-0050 §3 names that absence.
    await input(page).fill('ziplock bags')
    await page.locator('[data-test=ingredient-submit]').click()
    await expect(page.getByTestId('added-toast')).toContainText('Added to Other')

    const extra = page.getByTestId('extra-section')
    const uncategorized = extra
      .locator('[data-test=extra-subsection]')
      .filter({ has: page.getByRole('button', { name: /^Uncategorized:/ }) })
    const row = uncategorized.locator('li').filter({ hasText: 'ziplock bags' })
    await expect(row).toHaveCount(1)
    await expect(row.getByRole('button', { name: /Remove ziplock bags/ })).toBeVisible()
    // Still never routed into a real store section.
    await expect(page.locator('[data-test=grocery-section]').filter({ hasText: 'Other' })).toHaveCount(0)

    await expectZeroMealimeRequests(page)
  })

  test('an index-known extra (banana → Produce) gets its own Produce sub-section, not the store PRODUCE', async ({ page }) => {
    await input(page).fill('banana')
    await firstRow(page).click()
    await expect(page.getByTestId('added-toast')).toContainText('Added to Produce')

    const row = page
      .getByTestId('extra-section')
      .locator('[data-test=extra-subsection]')
      .filter({ has: page.getByRole('button', { name: /^Produce:/ }) })
      .locator('li')
      .filter({ hasText: 'banana' })
    await expect(row).toHaveCount(1)
    // The real Produce section (from the planned recipe) is untouched: it
    // has no row for the extra and keeps only its recipe-derived lines.
    const produce = page.locator('[data-test=grocery-section]').filter({ hasText: 'Produce' }).first()
    await expect(produce).toBeVisible()
    await expect(produce.locator('[data-test=grocery-row]').filter({ hasText: 'banana' })).toHaveCount(0)
  })

  test('extras group by category in STORE_SECTIONS order, Uncategorized last, empty categories omitted', async ({ page }) => {
    await input(page).fill('banana')
    await firstRow(page).click()
    await input(page).fill('ziplock bags')
    await page.locator('[data-test=ingredient-submit]').click()
    await input(page).fill('Sunshade tent')
    await pickCategoryOverride(page, 'Household')
    await page.locator('[data-test=ingredient-submit]').click()

    const names = page.getByTestId('extra-section').locator('[data-test=extra-subsection]')
    await expect(names).toHaveCount(3)
    // STORE_SECTIONS order (Produce … Household) with Uncategorized LAST,
    // and no empty sub-section is invented for the 27 other categories.
    const labels = await names
      .locator('[data-test=extra-subsection-toggle]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')))
    expect(labels).toEqual([
      'Produce: 0 of 1 checked',
      'Household: 0 of 1 checked',
      'Uncategorized: 0 of 1 checked',
    ])
  })

  test('an extras sub-section auto-collapses when its last extra is checked off (ADR-0008 rule)', async ({ page }) => {
    await input(page).fill('banana')
    await firstRow(page).click()
    await input(page).fill('granny smith')
    await pickCategoryOverride(page, 'Produce')
    await page.locator('[data-test=ingredient-submit]').click()

    const produce = page
      .getByTestId('extra-section')
      .locator('[data-test=extra-subsection]')
      .filter({ has: page.getByRole('button', { name: /^Produce:/ }) })
    const toggle = produce.getByTestId('extra-subsection-toggle')
    await expect(toggle).toHaveAttribute('aria-label', 'Produce: 0 of 2 checked')
    await expect(produce.locator('[data-test=extra-row]')).toHaveCount(2)

    // click(), never check(): the row DETACHES when it triggers the collapse.
    await produce.locator('[data-test=extra-row]:not(:has(input:checked))').first().locator('input[type=checkbox]').click()
    await expect(toggle).toHaveAttribute('aria-label', 'Produce: 1 of 2 checked')
    await produce.locator('[data-test=extra-row]:not(:has(input:checked))').first().locator('input[type=checkbox]').click()

    // Done → rows gone, header + count pill + chevron remain.
    await expect(produce.locator('[data-test=extra-row]')).toHaveCount(0)
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(toggle).toHaveAttribute('aria-label', 'Produce: 2 of 2 checked')
    await expect(toggle.getByTestId('section-count-pill')).toHaveText('2/2')

    // Re-opening + unchecking re-expands (true→false).
    await toggle.click()
    await expect(produce.locator('[data-test=extra-row]')).toHaveCount(2)
    await produce.locator('[data-test=extra-row]:has(input:checked)').first().locator('input[type=checkbox]').click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  })

  test('collapsing the extras Produce does NOT collapse the store Produce (namespaced keys)', async ({ page }) => {
    await input(page).fill('banana')
    await firstRow(page).click()
    await expect(page.getByTestId('added-toast')).toContainText('Added to Produce')

    const extraProduce = page
      .getByTestId('extra-section')
      .locator('[data-test=extra-subsection]')
      .filter({ has: page.getByRole('button', { name: /^Produce:/ }) })
    const storeProduce = page.locator('[data-test=grocery-section]').filter({ hasText: 'Produce' }).first()

    // The store section is expanded with its recipe-derived rows.
    const storeRows = storeProduce.locator('[data-test=grocery-row]')
    const storeTotal = await storeRows.count()
    expect(storeTotal).toBeGreaterThan(0)
    await expect(storeProduce.getByTestId('grocery-section-rows')).toBeVisible()

    // Collapse the EXTRAS Produce: the store Produce must be untouched —
    // both groups are called "Produce", and only the namespace keeps them
    // apart (ADR-0050 §5).
    await extraProduce.getByTestId('extra-subsection-toggle').click()
    await expect(extraProduce.getByTestId('extra-subsection-rows')).toHaveCount(0)
    await expect(storeProduce.getByTestId('grocery-section-rows')).toBeVisible()
    await expect(storeRows).toHaveCount(storeTotal)

    // …and the other way round.
    await extraProduce.getByTestId('extra-subsection-toggle').click()
    await storeProduce.getByTestId('grocery-section-toggle').click()
    await expect(storeProduce.locator('[data-test=grocery-row]')).toHaveCount(0)
    await expect(extraProduce.getByTestId('extra-subsection-rows')).toBeVisible()
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
    // Chevron icon, not a ▸ glyph: the collapsed state is pinned by
    // aria-expanded above, and the icon must not report text content.
    await expect(toggle.locator('svg')).toHaveCount(1)

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

  test('a one-item extras sub-section auto-collapses too, uniformly with store sections (ADR-0050 addendum)', async ({ page }) => {
    await blockExternalRequests(page)
    await planFirstRecipe(page)
    await input(page).fill('Sticky tape')
    await page.locator('[data-test=ingredient-submit]').click()
    await expect(page.getByTestId('extra-section')).toContainText('Sticky tape')

    await page.getByTestId('start-shopping').click()
    const extras = page.getByTestId('shop-custom-items')
    await expect(extras.locator('[data-test=shop-row]')).toHaveCount(1)
    await extras.locator('[data-test=shop-row]').click()

    // The sub-section is now done → it auto-collapses like every other
    // group on the screen (ADR-0050 addendum: the owner reversed the
    // manual-only rule; a single-item sub-section gets the SAME rule —
    // the checked row stays visible in the 1/1 pill and returns on
    // uncheck, so nothing is lost).
    const subsection = extras.locator('[data-test=shop-extra-subsection]')
    const subToggle = subsection.getByTestId('shop-extra-subsection-toggle')
    await expect(extras.locator('[data-test=shop-row]')).toHaveCount(0)
    await expect(subToggle).toHaveAttribute('aria-expanded', 'false')
    await expect(subsection.getByTestId('section-count-pill')).toHaveText('1/1')

    // The outer "Extra items" GROUP header is still not a section: it
    // keeps its own manual-only boolean and stays expanded.
    await expect(extras.getByTestId('shop-section-toggle')).toHaveAttribute('aria-expanded', 'true')

    // Manual click on the auto-collapsed header re-opens and pins it.
    await subToggle.click()
    await expect(subToggle).toHaveAttribute('aria-expanded', 'true')
    await expect(extras.locator('[data-test=shop-row]')).toHaveCount(1)

    // Unchecking re-expands behaviour: the row goes dim, done=false.
    await extras.locator('[data-test=shop-row]').click()
    await expect(extras.locator('[data-test=shop-row]')).toHaveCount(1)
    await expect(subToggle).toHaveAttribute('aria-expanded', 'true')
    await expect(subsection.getByTestId('section-count-pill')).toHaveText('0/1')

    // Manual collapse still works.
    await subToggle.click()
    await expect(extras.locator('[data-test=shop-row]')).toHaveCount(0)
  })
})

/**
 * ADR-0050 follow-up: the SHOPPING screen gets the same extras
 * sub-sectioning the Grocery tab already had (the owner showed
 * /shop with one flat "Extra items" list above "Produce"), plus the two
 * fixes the PR's reviewers found: the combobox announcing a listbox
 * that is not in the DOM, and a re-added extra vanishing into a
 * collapsed group.
 */
test.describe('ShopView extras sub-sections (ADR-0050)', () => {
  test('extras are grouped by their own category, same order as the Grocery tab', async ({ page }) => {
    await blockExternalRequests(page)
    await planFirstRecipe(page)

    // Two Produce extras, one Dairy, one with no remembered category.
    await input(page).fill('banana')
    await pickCategoryOverride(page, 'Produce')
    await page.locator('[data-test=ingredient-submit]').click()
    await input(page).fill('celery')
    await pickCategoryOverride(page, 'Produce')
    await page.locator('[data-test=ingredient-submit]').click()
    await input(page).fill('egg')
    await pickCategoryOverride(page, 'Dairy, Cheese & Eggs')
    await page.locator('[data-test=ingredient-submit]').click()
    await input(page).fill('Sticky tape')
    await page.locator('[data-test=ingredient-submit]').click()

    await page.getByTestId('start-shopping').click()
    await expect(page.getByTestId('shopping-progress')).toBeVisible()

    const extras = page.getByTestId('shop-custom-items')
    await expect(extras).toBeVisible()

    // STORE_SECTIONS order (Produce before Dairy, Cheese & Eggs), with
    // Uncategorized LAST, and empty groups omitted entirely.
    const order = await extras
      .locator('[data-test=shop-extra-subsection]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-extra-category')))
    expect(order).toEqual(['Produce', 'Dairy, Cheese & Eggs', 'Uncategorized'])

    // The rows really are inside their sub-section, not one flat list.
    const produce = extras
      .locator('[data-test=shop-extra-subsection]')
      .filter({ has: page.locator('button[aria-label^="Produce:"]') })
    await expect(produce.locator('[data-test=shop-row]')).toHaveCount(2)
    await expect(produce).toContainText('banana')
    await expect(produce).toContainText('celery')
    await expect(extras.locator('[data-test=shop-row]')).toHaveCount(4)

    // The sub-section headers are shop headers: N/N pill + accessible name.
    await expect(
      extras.getByRole('button', { name: 'Produce: 0 of 2 checked' }),
    ).toBeVisible()
    await expect(
      extras.getByRole('button', { name: 'Uncategorized: 0 of 1 checked' }).getByTestId('section-count-pill'),
    ).toHaveText('0/1')

    await expectZeroMealimeRequests(page)
  })

  test('an extras sub-section is never routed into the matching store section (ADR-0015 §2)', async ({ page }) => {
    await blockExternalRequests(page)
    await planFirstRecipe(page)
    await input(page).fill('banana')
    await pickCategoryOverride(page, 'Produce')
    await page.locator('[data-test=ingredient-submit]').click()

    await page.getByTestId('start-shopping').click()

    const storeProduce = page
      .locator('[data-test=shop-section]')
      .filter({ has: page.getByText('Produce', { exact: true }) })
    const storeRowsBefore = await storeProduce.locator('[data-test=shop-row]').count()
    await expect(storeRowsBefore).toBeGreaterThan(0)
    await expect(storeProduce).not.toContainText('banana')

    const extrasProduce = page
      .getByTestId('shop-custom-items')
      .locator('[data-test=shop-extra-subsection]')
      .filter({ has: page.locator('button[aria-label^="Produce:"]') })
    await expect(extrasProduce).toBeVisible()
    await expect(extrasProduce.locator('[data-test=shop-row]')).toHaveCount(1)

    // Collapsing the EXTRAS Produce leaves the recipe-derived one open —
    // both are called "Produce", only the namespace separates them.
    await extrasProduce.getByTestId('shop-extra-subsection-toggle').click()
    await expect(extrasProduce.getByTestId('shop-extra-subsection-rows')).toHaveCount(0)
    await expect(storeProduce.locator('[data-test=shop-row]')).toHaveCount(storeRowsBefore)
  })

  test('an extras sub-section auto-collapses when done; unchecking re-expands; the store twin stays open (ADR-0050 addendum)', async ({ page }) => {
    await blockExternalRequests(page)
    await planFirstRecipe(page)
    await input(page).fill('banana')
    await pickCategoryOverride(page, 'Produce')
    await page.locator('[data-test=ingredient-submit]').click()

    await page.getByTestId('start-shopping').click()

    const extras = page.getByTestId('shop-custom-items')
    // Prefix-located: the name carries the running N/N, which is the very
    // thing this test watches change.
    const subsection = extras
      .locator('[data-test=shop-extra-subsection]')
      .filter({ has: page.locator('button[aria-label^="Produce:"]') })
    const toggle = extras.locator('button[aria-label^="Produce:"]')

    // Completing the sub-section auto-collapses it — uniformly with the
    // store sections (ADR-0050 addendum reverses the manual-only rule;
    // the checked row stays visible in the 1/1 pill and returns on
    // uncheck, so a one-item sub-section loses nothing).
    await extras.locator('[data-test=shop-row]').click()
    await expect(extras.locator('[data-test=shop-row]')).toHaveCount(0)
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(subsection.getByTestId('section-count-pill')).toHaveText('1/1')
    // The outer "Extra items" GROUP header is not a section: manual-only.
    await expect(extras.getByTestId('shop-section-toggle')).toHaveAttribute('aria-expanded', 'true')

    // The recipe-derived Produce section is a DIFFERENT group: untouched
    // by the extras collapse, and still open (it is not done).
    const storeProduce = page
      .locator('[data-test=shop-section]')
      .filter({ has: page.getByText('Produce', { exact: true }) })
    const storeRows = await storeProduce.locator('[data-test=shop-row]').count()
    expect(storeRows).toBeGreaterThan(0)

    // Manual click re-opens and pins the auto-collapsed sub-section.
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(extras.locator('[data-test=shop-row]')).toHaveCount(1)

    // Unchecking drops done → auto state cleared, the group stays open.
    await extras.locator('[data-test=shop-row]').click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(subsection.getByTestId('section-count-pill')).toHaveText('0/1')
    await expect(extras.locator('[data-test=shop-row]')).toHaveCount(1)

    // Manual collapse of the whole extras GROUP still works.
    await extras.getByTestId('shop-section-toggle').click()
    await expect(extras.locator('[data-test=shop-row]')).toHaveCount(0)

    await expectZeroMealimeRequests(page)
  })

  test('checked extras sink to the bottom of their sub-section, stable (ADR-0050 addendum)', async ({ page }) => {
    await blockExternalRequests(page)
    await planFirstRecipe(page)
    // Three Produce extras so a MIDDLE check shows both the sink and the
    // stability of the untouched rows.
    for (const name of ['banana', 'celery', 'eggplant']) {
      await input(page).fill(name)
      await pickCategoryOverride(page, 'Produce')
      await page.locator('[data-test=ingredient-submit]').click()
    }

    await page.getByTestId('start-shopping').click()

    const produce = page
      .getByTestId('shop-custom-items')
      .locator('[data-test=shop-extra-subsection]')
      .filter({ has: page.locator('button[aria-label^="Produce:"]') })
    const names = async (): Promise<(string | undefined)[]> =>
      produce
        .locator('[data-test=shop-row]')
        .evaluateAll((els) => els.map((el) => el.textContent?.trim()))

    await expect(await names()).toEqual(['banana', 'celery', 'eggplant'])

    // Check the MIDDLE row: it sinks last, the others keep their order.
    await produce.locator('[data-test=shop-row]').filter({ hasText: 'celery' }).click()
    await expect(await names()).toEqual(['banana', 'eggplant', 'celery'])

    // Check another one: still stable relative to the untouched row.
    await produce.locator('[data-test=shop-row]').filter({ hasText: 'banana' }).click()
    await expect(await names()).toEqual(['eggplant', 'banana', 'celery'])

    // Check the LAST open row: everything is done now.
    await produce.locator('[data-test=shop-row]').filter({ hasText: 'eggplant' }).click()

    // The sub-section is now done → auto-collapsed (3/3 pill).
    await expect(produce.getByTestId('section-count-pill')).toHaveText('3/3')
    await expect(produce.locator('[data-test=shop-row]')).toHaveCount(0)

    // Re-open (manual pin): the all-checked group is UNCHANGED in order —
    // the sink is stable even when everything is done.
    await produce.getByTestId('shop-extra-subsection-toggle').click()
    await expect(await names()).toEqual(['banana', 'celery', 'eggplant'])

    await expectZeroMealimeRequests(page)
  })
})

test.describe('extras checkbox key hygiene (ADR-0050 addendum)', () => {
  test('removing an extra drops its checked key: the re-added row is unchecked and visible', async ({ page }) => {
    await blockExternalRequests(page)
    await planFirstRecipe(page)

    // A SECOND, never-checked extra keeps the sub-section out of "done",
    // so checking one row does not auto-collapse it and the row under
    // test stays in the DOM (ADR-0008; same reason the sibling specs
    // click() rather than check()).
    await input(page).fill('Cellophane')
    await page.locator('[data-test=ingredient-submit]').click()
    await input(page).fill('Sticky tape')
    await page.locator('[data-test=ingredient-submit]').click()
    await expect(page.getByTestId('extra-section')).toContainText('Sticky tape')

    const extraRow = page
      .getByTestId('extra-section')
      .locator('[data-test=extra-row]')
      .filter({ hasText: 'Sticky tape' })
    await extraRow.locator('input[type=checkbox]').click()
    await expect(extraRow.locator('input[type=checkbox]')).toBeChecked()

    // Removing it must take the checkbox key with it.
    await page.getByRole('button', { name: 'Remove Sticky tape from the grocery list' }).click()
    await expect(page.getByTestId('extra-section')).not.toContainText('Sticky tape')

    // Re-add the SAME name. Before the fix, the stale `custom||sticky
    // tape` key made the row read as already-done, the sub-section's
    // done-map went false→true and the watcher collapsed the group that
    // had just been emptied — the new row vanished behind its header.
    await input(page).fill('Sticky tape')
    await page.locator('[data-test=ingredient-submit]').click()

    const readded = page
      .getByTestId('extra-section')
      .locator('[data-test=extra-row]')
      .filter({ hasText: 'Sticky tape' })
    await expect(readded).toBeVisible()
    await expect(readded.locator('input[type=checkbox]')).not.toBeChecked()
    // And the group is still OPEN: a collapse here is the bug, so assert
    // the state the watcher must NOT reach.
    await expect(page.locator('[data-test=extra-section] button[aria-label^="Uncategorized:"]')).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    await expect(page.getByTestId('extra-section').locator('[data-test=extra-row]')).toHaveCount(2)

    await expectZeroMealimeRequests(page)
  })
})

test.describe('add-item combobox ARIA (ADR-0050 addendum)', () => {
  test('aria-expanded / aria-controls track whether the listbox is actually rendered', async ({ page }) => {
    await blockExternalRequests(page)
    await planFirstRecipe(page)

    const field = input(page)
    await field.fill('banana')
    const listbox = page.getByTestId('ingredient-suggestions')
    await expect(listbox).toBeVisible()
    await expect(field).toHaveAttribute('aria-expanded', 'true')
    const controls = await field.getAttribute('aria-controls')
    expect(controls).toBe(await listbox.getAttribute('id'))

    // Opening the category popup stands the suggestions down — so the
    // combobox must stop claiming a controlled listbox that is gone.
    await page.locator('[data-test=ingredient-category]').click()
    const menu = page.locator('[data-test=ingredient-category-menu]')
    await expect(menu).toBeVisible()
    await expect(listbox).toHaveCount(0)
    await expect(field).toHaveAttribute('aria-expanded', 'false')
    expect(await field.getAttribute('aria-controls')).toBeNull()
    expect(await field.getAttribute('aria-activedescendant')).toBeNull()

    // Choosing a category closes the popup. Typing brings the listbox
    // back and aria-expanded says so again — the same derived value in
    // both directions, which is what the pre-fix code got wrong on one
    // side of the transition only.
    await menu.locator('[data-test=ingredient-category-option-Produce]').click()
    await expect(menu).toHaveCount(0)
    await field.fill('bananas')
    await expect(listbox).toBeVisible()
    await expect(field).toHaveAttribute('aria-expanded', 'true')
    expect(await field.getAttribute('aria-controls')).toBe(await listbox.getAttribute('id'))

    await expectZeroMealimeRequests(page)
  })
})
