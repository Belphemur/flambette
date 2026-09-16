import { expect, test, type Page } from '@playwright/test'
import { blockExternalRequests, gotoTab, waitForCatalog } from './helpers'

test.beforeEach(async ({ page }) => {
  await blockExternalRequests(page)
})

test('share link restores the plan in a fresh browser context', async ({ page, browser }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/')
  await waitForCatalog(page)

  // Add the first recipe and bump its servings to 3 so the restored plan
  // can be checked for servings fidelity.
  await page.locator('main article').first().click()
  const sheet = page.getByRole('dialog')
  await expect(sheet).toBeVisible()
  const firstName = (await sheet.getByRole('heading', { level: 2 }).textContent())!.trim()
  // Drop servings to 3 (base is 6), then add to the plan
  await sheet.getByRole('button', { name: 'Fewer servings' }).click()
  await sheet.getByRole('button', { name: 'Fewer servings' }).click()
  await sheet.getByRole('button', { name: 'Fewer servings' }).click()
  await sheet.getByRole('button', { name: /Add to plan|Update in plan/ }).click()

  // Back to the grid, then add a second recipe (the detail view is routed,
  // so the grid only exists once we navigate back).
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await waitForCatalog(page)
  await page.locator('main article').nth(1).click()
  const sheet2 = page.getByRole('dialog')
  await expect(sheet2).toBeVisible()
  const secondName = (await sheet2.getByRole('heading', { level: 2 }).textContent())!.trim()
  await sheet2.getByRole('button', { name: /Add to plan|Update in plan/ }).click()

  // Add a free-form grocery item — it must ride along in the share payload.
  await gotoTab(page, 'Grocery')
  await page.getByLabel('Add a custom grocery item').fill('Sparkling water')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.getByTestId('custom-items')).toContainText('Sparkling water')

  await gotoTab(page, 'Plan')
  const plannedNames = (await page.locator('main h3').allTextContents()).map((s) => s.trim())
  expect(plannedNames).toEqual([firstName, secondName])

  // Open the share sheet and copy the link
  await page.getByRole('button', { name: 'Share', exact: true }).click()
  const shareSheet = page.getByRole('dialog', { name: 'Share your meal plan' })
  await expect(shareSheet).toBeVisible()
  const shareLink = await shareSheet.getByRole('textbox', { name: 'Share link' }).inputValue()
  expect(shareLink).toContain('?p=')
  await shareSheet.getByRole('button', { name: 'Copy one-time link' }).click()
  await expect(shareSheet.getByRole('button', { name: /Copied/ })).toBeVisible()

  // Fresh, incognito-like context: no storage state carried over
  const freshContext = await browser.newContext({ storageState: undefined })
  const freshPage = await freshContext.newPage()
  await blockExternalRequests(freshPage)
  await freshPage.goto(shareLink)
  await expect(freshPage.getByText('Plan loaded from link')).toBeVisible({
    timeout: 10_000,
  })

  // Plan restored with the right meals and servings — and the grocery list
  // is prefilled automatically from the imported plan.
  await gotoTab(freshPage, 'Plan')
  // Catalog load races the row render on a cold context — wait for rows.
  await expect(freshPage.locator('main h3').first()).toBeVisible({ timeout: 15_000 })
  const restoredNames = (await freshPage.locator('main h3').allTextContents()).map((s) => s.trim())
  expect(restoredNames).toEqual(plannedNames)
  const servings = await freshPage
    .getByRole('heading', { name: firstName })
    .locator('xpath=ancestor::li')
    .getByLabel('Servings', { exact: true })
    .textContent()
  expect(Number(servings)).toBe(3)

  await gotoTab(freshPage, 'Grocery')
  await expect(freshPage.locator('main').getByText(/\d+ \/ \d+ items/)).toBeVisible({
    timeout: 15_000,
  })
  // The free-form item made it through the share payload too.
  await expect(freshPage.getByTestId('custom-items')).toContainText('Sparkling water')

  await freshContext.close()
})

test('desktop chromium without navigator.share falls back to copy', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'navigator.share presence differs per browser')
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/')
  await waitForCatalog(page)

  await page.locator('main article').first().click()
  const sheet = page.getByRole('dialog')
  await expect(sheet).toBeVisible()
  await sheet.getByRole('button', { name: /Add to plan|Update in plan/ }).click()
  await gotoTab(page, 'Plan')

  // Desktop chromium has no navigator.share by default — assert the fallback
  const hasShare = await page.evaluate(() => typeof navigator.share === 'function')
  if (hasShare) {
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'share', { value: undefined, configurable: true })
    })
  }

  await page.getByRole('button', { name: 'Share', exact: true }).click()
  const shareSheet = page.getByRole('dialog', { name: 'Share your meal plan' })
  await expect(shareSheet).toBeVisible()
  // No native "Share…" button rendered when navigator.share is absent
  await expect(shareSheet.getByRole('button', { name: 'Share…' })).toHaveCount(0)

  await shareSheet.getByRole('button', { name: 'Copy one-time link' }).click()
  await expect(shareSheet.getByRole('button', { name: /Copied/ })).toBeVisible()
})

test('oversized plans fall back to the live room share', async ({ page }) => {
  await page.goto('/')
  await waitForCatalog(page)

  // Seed a plan big enough that the gzipped payload blows past the
  // 1800-char URL budget (~650 meals with realistic ids; gzip compresses
  // the repetitive JSON hard, so smaller plans always fit).
  const variantIds: number[] = await page.evaluate(async () => {
    const data = await fetch('/data/builder_data.json').then((r) => r.json())
    return (data.feasible_variants as number[]).slice(0, 650)
  })
  await page.addInitScript(
    (ids: number[]) => {
      const plan = ids.map((variantId) => ({ variantId, servings: 2 }))
      localStorage.setItem('mealime-planner:v1:plan', JSON.stringify({ plan }))
    },
    variantIds,
  )
  await page.reload()
  await waitForCatalog(page)

  await gotoTab(page, 'Plan')
  // The Share button stays available — a live room doesn't have the URL
  // size limit. The sheet shows the one-time link as unavailable with a
  // hint pointing at the live room.
  const shareButton = page.getByRole('button', { name: 'Share', exact: true })
  await page.waitForTimeout(500)
  await expect(shareButton).toBeEnabled({ timeout: 15_000 })
  await shareButton.click()
  const shareSheet = page.getByRole('dialog', { name: 'Share your meal plan' })
  await expect(shareSheet).toBeVisible()
  const oneTime = shareSheet.getByRole('button', { name: 'Copy one-time link' })
  await expect(oneTime).toBeDisabled({ timeout: 15_000 })
  await expect(shareSheet.getByText(/Plan too large for a one-time link/)).toBeVisible()
  // The live room escape hatch is still there and usable.
  await expect(shareSheet.getByTestId('start-room')).toBeEnabled()
})
