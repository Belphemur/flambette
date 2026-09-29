import { expect, test, type Page } from '@playwright/test'
import {
  blockExternalRequests,
  expectZeroMealimeRequests,
  gotoTab,
  openFirstRecipeDetail,
  openRecipeDetail,
  waitForCatalog,
} from './helpers'

/**
 * Cooking history (ADR-0011, shared with the room BY DEFAULT since
 * ADR-0032): cookedHistory is written by markCooked, shown on the recipe
 * detail line and in the /history tab, and travels in the room payload
 * unless the SENDER has opted out via shareCookedHistory.
 *
 * The "room-excluded by default" case below is the deliberate update of a
 * spec that encoded the old policy: it now opts OUT on the sender and
 * proves the payload carries no cookedHistory.
 */

async function planAndCook(page: Page): Promise<string> {
  await page.goto('/')
  await waitForCatalog(page)
  const name = await openFirstRecipeDetail(page)
  await page.getByRole('dialog').getByRole('button', { name: 'Add to plan' }).click()
  await gotoTab(page, 'Plan')
  await page.getByRole('button', { name: `Mark ${name} as cooked` }).click()
  await expect(page.getByText('Your meal plan is empty')).toBeVisible()
  return name
}

/** Start a live room from A's plan tab share sheet; returns the room link. */
async function startLiveRoom(page: Page): Promise<string> {
  await gotoTab(page, 'Plan')
  await page.getByRole('button', { name: 'Share', exact: true }).click()
  await page.getByTestId('start-room').click()
  const chip = page.getByTestId('room-chip')
  await expect(chip).toContainText('Live', { timeout: 10_000 })
  const title = await chip.getAttribute('title')
  const code = title!.match(/Live room ([a-z0-9-]+)/)![1]
  return `${page.url().replace(/\/plan.*$/, '')}/plan?room=${code}`
}

test('cooking a planned meal records it in detail + history, and aggregates', async ({ page }) => {
  await blockExternalRequests(page)
  const name = await planAndCook(page)

  // Detail line: "Cooked 1 time · last …" (relative).
  await gotoTab(page, 'Recipes')
  await openRecipeDetail(page, name)
  await expect(page.getByTestId('cook-history')).toContainText('Cooked 1 time')
  await expect(page.getByTestId('cook-history')).toContainText(/last \w+ ago|last just now/)

  // History tab: one aggregated row.
  await gotoTab(page, 'History')
  const rows = page.getByTestId('history-row')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText(name)
  await expect(page.getByText('cooked once')).toBeVisible()

  // Cook the SAME recipe a second time -> one row, count 2.
  await gotoTab(page, 'Recipes')
  await openRecipeDetail(page, name)
  await page.getByRole('dialog').getByRole('button', { name: 'Add to plan' }).click()
  await gotoTab(page, 'Plan')
  await page.getByRole('button', { name: `Mark ${name} as cooked` }).click()
  await gotoTab(page, 'History')
  await expect(page.getByTestId('history-row')).toHaveCount(1)
  await expect(page.getByText('cooked 2 times')).toBeVisible()

  await expectZeroMealimeRequests(page)
})

test('history and the detail line survive a reload', async ({ page }) => {
  await blockExternalRequests(page)
  const name = await planAndCook(page)

  await gotoTab(page, 'History')
  await expect(page.getByTestId('history-row').first()).toContainText(name)
  await page.reload()
  await expect(page.getByTestId('history-row').first()).toContainText(name)

  await gotoTab(page, 'Recipes')
  await openRecipeDetail(page, name)
  await expect(page.getByTestId('cook-history')).toContainText('Cooked 1 time')
})

test('empty state before anything is cooked', async ({ page }) => {
  await blockExternalRequests(page)
  await page.goto('/history')
  const empty = page.getByTestId('history-empty')
  await expect(empty).toContainText('Nothing cooked yet')
  await expect(empty).toContainText('Mark meals as cooked when you finish them.')
  await expect(page.getByTestId('history-row')).toHaveCount(0)
})

test('cooked history is shared by default: B in the room sees A cooked meals', async ({ browser }) => {
  const ctxA = await browser.newContext()
  const a = await ctxA.newPage()
  await blockExternalRequests(a)
  const name = await planAndCook(a)
  // Keep a (shared) plan entry so the Plan tab shows the Share button.
  await a.goto('/')
  await openRecipeDetail(a, name)
  await a.getByRole('dialog').getByRole('button', { name: 'Add to plan' }).click()
  const roomUrl = await startLiveRoom(a)

  // B joins in a FRESH context via the room link.
  const ctxB = await browser.newContext()
  const b = await ctxB.newPage()
  await blockExternalRequests(b)
  await b.goto(roomUrl)
  await expect(b.getByTestId('room-chip')).toContainText('Live', { timeout: 10_000 })

  // B got the SHARED plan state AND the cooked history (ADR-0032).
  await b.goto('/history')
  await expect(b.getByTestId('history-row').first()).toContainText(name, { timeout: 15_000 })
  const stored = await b.evaluate(() =>
    JSON.parse(localStorage.getItem('mealime-planner:v1:plan') ?? '{}'),
  )
  expect((stored.cookedHistory ?? []).length).toBeGreaterThan(0)

  // Sanity: A still sees the row in their own history.
  await a.goto('/history')
  await expect(a.getByTestId('history-row').first()).toContainText(name)
})

test('an explicit opt-out keeps cooked history off the wire (ADR-0032)', async ({ browser }) => {
  const ctxA = await browser.newContext()
  const a = await ctxA.newPage()
  await blockExternalRequests(a)
  const name = await planAndCook(a)
  // Keep a (shared) plan entry so the Plan tab shows the Share button.
  await a.goto('/')
  await openRecipeDetail(a, name)
  await a.getByRole('dialog').getByRole('button', { name: 'Add to plan' }).click()

  // The opt-out is a per-device choice: take it BEFORE joining the room.
  await a.goto('/settings')
  await a.getByTestId('share-cooked-history').uncheck()
  const roomUrl = await startLiveRoom(a)

  const ctxB = await browser.newContext()
  const b = await ctxB.newPage()
  await blockExternalRequests(b)
  await b.goto(roomUrl)
  await expect(b.getByTestId('room-chip')).toContainText('Live', { timeout: 10_000 })

  // The shared plan arrived; the opted-out history did NOT.
  await b.goto('/history')
  await expect(b.getByTestId('history-empty')).toContainText('Nothing cooked yet')
  await expect(b.getByTestId('history-row')).toHaveCount(0)
  const stored = await b.evaluate(() =>
    JSON.parse(localStorage.getItem('mealime-planner:v1:plan') ?? '{}'),
  )
  expect(stored.cookedHistory ?? []).toEqual([])

  // A's own history is untouched by the choice.
  await a.goto('/history')
  await expect(a.getByTestId('history-row').first()).toContainText(name)
})
