import { expect, test, type Page } from '@playwright/test'
import {
  blockExternalRequests,
  expectZeroMealimeRequests,
  gotoTab,
  openFirstRecipeDetail,
  waitForCatalog,
} from './helpers'

/**
 * Phase 18 — three-word room codes (ADR-0021).
 *
 * A room code is now `amber-falcon-lantern`: rolled on the CLIENT so the
 * user can read it out before anyone joins, with the legacy 4–12 char
 * alphanumeric code still accepted everywhere (ADR-0019 households
 * already have one persisted).
 */

const WORD_CODE = /^[a-z]{3,10}-[a-z]{3,10}-[a-z]{3,10}$/
const LEGACY_CODE = /^[A-Z0-9]{4,12}$/

test.beforeEach(async ({ page }) => {
  await blockExternalRequests(page)
  await page.goto('/')
  await waitForCatalog(page)
})

/** Plan a recipe (the share sheet only renders with a planned meal). */
async function planARecipe(page: Page): Promise<string> {
  const name = await openFirstRecipeDetail(page)
  await page.getByRole('dialog').getByRole('button', { name: 'Add to plan' }).click()
  return name
}

/** Start a live room from the Plan tab's share sheet; returns the code. */
async function startLiveRoom(page: Page): Promise<string> {
  await gotoTab(page, 'Plan')
  await page.getByRole('button', { name: 'Share', exact: true }).click()
  await page.getByTestId('start-room').click()
  const chip = page.getByTestId('room-chip')
  await expect(chip).toContainText('Live', { timeout: 15_000 })
  const code = (await chip.getAttribute('title'))!.match(/Live room ([a-z0-9-]+)/)![1]
  // Close the sheet: it is a full-screen overlay that would swallow the
  // bottom-nav clicks the rest of the test needs.
  await page.getByRole('button', { name: 'Close share sheet' }).click()
  await expect(page.getByRole('dialog', { name: 'Share your meal plan' })).toHaveCount(0)
  return code
}

/** The app shell is up (catalog finished loading, nav clickable). */
async function waitForApp(page: Page) {
  await expect(page.getByText('Loading…')).toBeHidden({ timeout: 20_000 })
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible()
}

test('a new room gets a three-word code that a second device joins by link', async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000)
  const recipeName = await planARecipe(page)
  const code = await startLiveRoom(page)

  // The code rolled client-side is three readable words, not 6 chars.
  expect(code).toMatch(WORD_CODE)

  // A fresh device joins by the ?room= deep link and gets the plan.
  const ctxB = await browser.newContext()
  const b = await ctxB.newPage()
  await blockExternalRequests(b)
  await b.goto(`/plan?room=${code}`)
  await expect(b.getByTestId('room-chip')).toContainText('Live', { timeout: 20_000 })
  await gotoTab(b, 'Plan')
  await expect(b.getByRole('heading', { level: 3, name: recipeName })).toBeVisible({
    timeout: 20_000,
  })
  await ctxB.close()
  await expectZeroMealimeRequests(page)
})

test('Settings generates a code and a saved one auto-joins after a fresh start', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await planARecipe(page)
  const code = await startLiveRoom(page)

  // "New code" fills the field with a fresh three-word code.
  await gotoTab(page, 'Settings')
  await page.getByTestId('household-room-new').click()
  const rolled = await page.getByTestId('household-room-input').inputValue()
  expect(rolled).toMatch(WORD_CODE)

  // Typing the LIVE room in a sloppy shape still normalizes to the
  // canonical hyphenated code (spaces / upper case / no separators).
  const sloppy = code.toUpperCase().replace(/-/g, ' ')
  await page.getByTestId('household-room-input').fill(sloppy)
  await page.getByTestId('household-room-save').click()
  await expect(page.getByTestId('household-room-status')).toContainText(code)
  await expect(page.getByTestId('household-room-input')).toHaveValue(code)

  // Fresh start (new session, no stored room code) → the app re-joins it.
  await page.evaluate(() => sessionStorage.clear())
  await page.reload()
  await waitForApp(page)
  await expect(page.getByTestId('household-toast')).toContainText(code, { timeout: 20_000 })
  await expect(page.getByTestId('room-chip')).toContainText('Live', { timeout: 20_000 })
  await expectZeroMealimeRequests(page)
})

test('a legacy alphanumeric room code still joins', async ({ page }) => {
  test.setTimeout(90_000)
  await planARecipe(page)
  await startLiveRoom(page)

  // Mint a LEGACY room straight from the relay protocol (what an older
  // client sends: `create` with no code) and join it with the app.
  const legacy = await page.evaluate(async () => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    return await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`${proto}//${location.host}/ws`)
      const timer = setTimeout(() => reject(new Error('relay timeout')), 10_000)
      ws.onopen = () => ws.send(JSON.stringify({ type: 'create' }))
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data as string) as { type: string; code?: string }
        if (msg.type === 'created' && msg.code) {
          clearTimeout(timer)
          ws.close()
          resolve(msg.code)
        }
      }
      ws.onerror = () => reject(new Error('relay unreachable'))
    })
  })
  expect(legacy).toMatch(LEGACY_CODE)

  await gotoTab(page, 'Settings')
  await page.getByTestId('household-room-input').fill(legacy.toLowerCase())
  await page.getByTestId('household-room-join').click()
  // Upper-cased on the way in, exactly as before ADR-0021.
  await expect(page.getByTestId('household-room-status')).toContainText(legacy)
  await expect(page.getByTestId('room-chip')).toContainText('Live', { timeout: 20_000 })
  await expectZeroMealimeRequests(page)
})

test('a nonsense code is refused rather than silently coerced', async ({ page }) => {
  await gotoTab(page, 'Settings')
  await page.getByTestId('household-room-input').fill('not-a-real-code')
  // Two tokens: neither a word code nor a legacy code.
  await expect(page.getByTestId('household-room-save')).toBeDisabled()
  await page.getByTestId('household-room-input').fill('amber-falcon')
  await expect(page.getByTestId('household-room-save')).toBeDisabled()
  await page.getByTestId('household-room-input').fill('amber falcon lantern')
  await expect(page.getByTestId('household-room-save')).toBeEnabled()
})
