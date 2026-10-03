import { expect, test, type Page } from '@playwright/test'
import {
  blockExternalRequests,
  expectZeroMealimeRequests,
  gotoTab,
  liveRoomCode,
  openFirstRecipeDetail,
  liveRoomPeers,
  waitForCatalog,
} from './helpers'

/**
 * The live peer count (ADR-0049), end to end through the Bun relay the e2e
 * suite starts: two real browser contexts, one relay, one `peers`
 * fan-out per membership change.
 *
 * The COUNT itself is pinned in `server/relay-core/lifecycle.test.ts`
 * (the core computes `livePeers + 1`) and the fan-out in
 * `server/worker/room.test.ts` (the adapters walk their own peer set).
 * What only this file can see is the whole chain: relay → socket → store
 * → tooltip text, on both viewports, including the DROP — which is the
 * half that silently rots, because nothing ever asserts a count going
 * back down.
 */

/** A is the household: start a room and return its code. */
async function startRoom(page: Page): Promise<string> {
  await page.goto('/')
  await waitForCatalog(page)
  // The header's Share action only exists once there is a plan to share.
  await openFirstRecipeDetail(page)
  await page.getByRole('dialog').getByRole('button', { name: 'Add to plan' }).click()
  await gotoTab(page, 'Plan')
  await page.getByRole('button', { name: 'Share', exact: true }).click()
  await page.getByTestId('start-room').click()
  const code = await liveRoomCode(page)
  // The share sheet is a full-screen overlay that would swallow the
  // bottom-nav clicks the settings assertions need.
  await page.getByRole('button', { name: 'Close share sheet' }).click()
  return code
}

test('the chip counts one peer before anyone else arrives', async ({ page }) => {
  await blockExternalRequests(page)
  await startRoom(page)

  // The green dot (ADR-0049) rides with the live state only.
  await expect(page.getByTestId('room-chip-dot')).toBeVisible()
  await expect(page.getByTestId('room-chip-dot')).toHaveClass(/bg-success/)
  // This device is the room's first member, and it counts ITSELF.
  expect(await liveRoomPeers(page)).toBe(1)
  await expectZeroMealimeRequests(page)
})

test('the live chip never makes the page scroll sideways (ADR-0049)', async ({ page }) => {
  await blockExternalRequests(page)
  await startRoom(page)

  // The chip's tooltip bubble is `visibility: hidden` or `display: none`
  // while closed — and ONLY the second one is safe. A hidden-but-laid-out
  // `whitespace-nowrap` bubble beside the header's right edge overflowed
  // the Pixel 7 viewport, which made the DOCUMENT horizontally scrollable
  // and silently broke every tap on the `fixed` bottom nav (Playwright
  // reported `main` intercepting the nav button). Nothing else on the page
  // could see it, so this pins the property itself.
  const overflow = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  }))
  expect(overflow.doc).toBeLessThanOrEqual(0)
  expect(overflow.body).toBeLessThanOrEqual(0)

  // …and the nav is genuinely tappable, which is what the overflow broke.
  await gotoTab(page, 'Grocery')
  await expect(page.getByPlaceholder('Add an item not in the recipes…')).toBeVisible()
  await expectZeroMealimeRequests(page)
})

test('a second device raises the count on BOTH phones', async ({ browser, page }) => {
  await blockExternalRequests(page)
  const code = await startRoom(page)

  const ctxB = await browser.newContext()
  const b = await ctxB.newPage()
  await blockExternalRequests(b)
  await b.goto(`/?room=${code}`)
  await expect(b.getByTestId('room-chip')).toContainText('Live', { timeout: 20_000 })

  // The JOINER learns the headcount in its own admission frame.
  await expect.poll(() => liveRoomPeers(b), { timeout: 20_000 }).toBe(2)
  // …and the peer ALREADY there is told too. A fan-out that only reached
  // the newcomer would leave the first phone permanently saying "1".
  await expect.poll(() => liveRoomPeers(page), { timeout: 20_000 }).toBe(2)

  await expectZeroMealimeRequests(b)
  await ctxB.close()
})

test('a departure lowers the count without a reload', async ({ browser, page }) => {
  await blockExternalRequests(page)
  const code = await startRoom(page)

  const ctxB = await browser.newContext()
  const b = await ctxB.newPage()
  await blockExternalRequests(b)
  await b.goto(`/?room=${code}`)
  await expect(b.getByTestId('room-chip')).toContainText('Live', { timeout: 20_000 })
  await expect.poll(() => liveRoomPeers(page), { timeout: 20_000 }).toBe(2)

  // Closing the tab is a real socket close, which is a membership change
  // the relay must announce. This is the assertion that keeps the count
  // from being a high-water mark.
  await ctxB.close()
  await expect.poll(() => liveRoomPeers(page), { timeout: 20_000 }).toBe(1)

  await expectZeroMealimeRequests(page)
})

test('the household card shows the count only while connected (ADR-0049)', async ({
  browser,
  page,
}) => {
  test.setTimeout(120_000)
  await blockExternalRequests(page)
  const code = await startRoom(page)

  await gotoTab(page, 'Settings')
  await page.getByTestId('household-room-input').fill(code)
  await page.getByTestId('household-room-join').click()
  await expect(page.getByTestId('household-room-status')).toContainText(code, { timeout: 20_000 })
  await expect(page.getByTestId('household-room-status')).toContainText('1 in room')

  const ctxB = await browser.newContext()
  const b = await ctxB.newPage()
  await blockExternalRequests(b)
  await b.goto(`/?room=${code}`)
  await expect(b.getByTestId('room-chip')).toContainText('Live', { timeout: 20_000 })
  await expect
    .poll(() => page.getByTestId('household-room-status').textContent(), { timeout: 20_000 })
    .toContain('2 in room')

  // Leave is a full opt-out, so the status line disappears with the
  // connection rather than claiming a live household.
  await page.getByTestId('household-room-clear').click()
  await expect(page.getByTestId('household-room-status')).toHaveCount(0)

  await ctxB.close()
  await expectZeroMealimeRequests(page)
})