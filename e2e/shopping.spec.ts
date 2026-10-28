import { expect, test } from '@playwright/test'
import {
  blockExternalRequests,
  gotoTab,
  openFirstRecipeDetail,
  tapShopRowToggle,
  waitForCatalog,
} from './helpers'

test.beforeEach(async ({ page }) => {
  await blockExternalRequests(page)
  await page.goto('/recipes')
  await waitForCatalog(page)
  await openFirstRecipeDetail(page)
  await page.getByRole('dialog').getByRole('button', { name: 'Add to plan' }).click()
})

test('shopping mode: enter, toggle, progress, exit', async ({ page }) => {
  await gotoTab(page, 'Grocery')
  await expect(page.locator('[data-test=start-shopping]')).toBeVisible()

  await page.locator('[data-test=start-shopping]').click()
  await expect(page).toHaveURL(/\/shop$/)

  // Full-screen: no app bottom nav, sticky progress bar with rows.
  await expect(page.locator('nav')).toHaveCount(0)
  const rows = page.locator('[data-test=shop-row]')
  await expect(rows.first()).toBeVisible()
  const total = await rows.count()
  expect(total).toBeGreaterThan(0)

  const progress = page.locator('[data-test=shopping-progress]')
  await expect(progress).toHaveText(/^0 \/ \d+$/)

  // Toggle a row: progress +1 and the row dims (fades to 40%). Checked rows
  // sink within their section, so assert on dimmed rows rather than position.
  await tapShopRowToggle(rows.first())
  await expect(progress).toHaveText(/^1 \/ \d+$/)
  await expect(page.locator('[data-test=shop-row].opacity-40')).toHaveCount(1)

  // Toggling again unchecks (rows are plain toggles).
  await tapShopRowToggle(page.locator('[data-test=shop-row].opacity-40').first())
  await expect(progress).toHaveText(/^0 \/ \d+$/)
  await expect(page.locator('[data-test=shop-row].opacity-40')).toHaveCount(0)

  // Toggle everything: keep tapping the first undimmed row (checked rows
  // sink live, so position-based iteration would double-tap).
  for (let i = 0; i < total; i++) {
    await tapShopRowToggle(page.locator('[data-test=shop-row]:not(.opacity-40)').first())
  }
  await expect(progress).toHaveText(new RegExp(`^${total} \\/ ${total}$`))

  // The last check arms the all-checked auto-trigger — the ONE confirm
  // modal now (ADR-0084), and it WAITS (no auto-dismiss), so it is
  // answered here: Cancel keeps the list (this spec is about shopping
  // progress, not the clear flow) and lets the exit click through.
  const confirm = page.getByTestId('confirm-modal')
  await expect(confirm).toContainText('All items checked — clear the grocery list?')
  await confirm.getByTestId('confirm-cancel').click()
  await expect(confirm).toHaveCount(0)

  // Exit returns to the grocery tab.
  await page.locator('[data-test=exit-shopping]').click()
  await expect(page).toHaveURL(/\/grocery$/)
})

test('shopping entry button is hidden when the list is empty', async ({ page }) => {
  await gotoTab(page, 'Plan')
  await page.getByRole('button', { name: 'Clear plan' }).click()
  await gotoTab(page, 'Grocery')
  await expect(page.getByText('Nothing to buy yet')).toBeVisible()
  await expect(page.locator('[data-test=start-shopping]')).toHaveCount(0)
})

test('shopping mode: custom items get their own section and collapse works', async ({ page }) => {
  await gotoTab(page, 'Grocery')
  await page.getByPlaceholder('Add an item not in the recipes…').fill('Sticky tape')
  await page.keyboard.press('Enter')

  await page.locator('[data-test=start-shopping]').click()
  const customRow = page.locator('[data-test=shop-custom-items] [data-test=shop-row]').filter({ hasText: 'Sticky tape' })
  await expect(customRow).toBeVisible()

  // Toggle via row tap: dims and counts toward progress — and, being the
  // only item, completes the sub-section, which auto-collapses it like
  // every group on the screen (ADR-0050 addendum). The checked row stays
  // visible in the collapsed header's 1/1 pill and returns on uncheck.
  await customRow.click()
  await expect(page.locator('[data-test=shop-custom-items] [data-test=shop-row]')).toHaveCount(0)
  const subToggle = page.locator('[data-test=shop-custom-items] [data-test=shop-extra-subsection-toggle]')
  await expect(subToggle).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('[data-test=shop-custom-items] [data-test=section-count-pill]')).toHaveText('1/1')
  // Manual click re-opens and pins the auto-collapsed sub-section.
  await subToggle.click()
  await expect(subToggle).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('[data-test=shop-custom-items] [data-test=shop-row]')).toHaveCount(1)

  // Collapsible sections: first section header collapses its list.
  // ADR-0075's grammar sweep wrapped the shop band's toggle in the band
  // row (the hue glyph sits outside the button so the toggle's own svg
  // count stays the chevron), so the pin is the semantic toggle hook
  // rather than a `section > button` structural selector.
  const headers = page.locator('main [data-test=shop-section-toggle]')
  await expect(headers.first()).toBeVisible()
  const first = headers.first()
  await first.click()
  await expect(first).toHaveAttribute('aria-expanded', 'false')
  await first.click()
  await expect(first).toHaveAttribute('aria-expanded', 'true')
})
