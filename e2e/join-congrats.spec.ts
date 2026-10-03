import { expect, test, type Page } from '@playwright/test'
import {
  blockExternalRequests,
  expectZeroMealimeRequests,
  gotoTab,
  liveRoomCode,
  openFirstRecipeDetail,
  waitForCatalog,
} from './helpers'

/**
 * The join-via-shared-link congrats modal (ADR-0049).
 *
 * The owner's ask was that arriving through a `?room=` link should be
 * CELEBRATED: one full page saying you have joined the household, with
 * the code on it, because the next thing you do with a household code is
 * show it to somebody else.
 *
 * The interesting half is the gate, not the markup. The modal must open
 * for a link join and ONLY for a link join — a household auto-join
 * (ADR-0019) has nobody to congratulate, and a broken link must not put
 * a "you've joined" screen over an error.
 */

/** Start a room on A and return the share link a household member gets. */
async function shareLink(page: Page): Promise<string> {
  await page.goto('/')
  await waitForCatalog(page)
  // The header's Share action only exists once there is a plan to share.
  await openFirstRecipeDetail(page)
  await page.getByRole('dialog').getByRole('button', { name: 'Add to plan' }).click()
  await gotoTab(page, 'Plan')
  await page.getByRole('button', { name: 'Share', exact: true }).click()
  await page.getByTestId('start-room').click()
  const code = await liveRoomCode(page)
  await page.getByRole('button', { name: 'Close share sheet' }).click()
  return code
}

test('a shared link opens the congrats modal with the code', async ({ browser }) => {
  const ctxA = await browser.newContext()
  const a = await ctxA.newPage()
  await blockExternalRequests(a)
  const code = await shareLink(a)

  // A second phone, opening the link cold — no saved household room, no
  // prior session: the only reason to be in this room is the link.
  const ctxB = await browser.newContext()
  const b = await ctxB.newPage()
  await blockExternalRequests(b)
  await b.goto(`/?room=${code}`)

  const dialog = b.getByRole('dialog', { name: 'Joined the household' })
  await expect(dialog).toBeVisible({ timeout: 20_000 })
  await expect(dialog).toContainText("You've joined the household")
  // The code is the payload: it is what the new member shows the household.
  await expect(b.getByTestId('join-congrats-code')).toHaveText(code)
  // It counts the household it just walked into.
  await expect(b.getByTestId('join-congrats-code')).toBeVisible()

  // One CTA, and it really dismisses: the app underneath is reachable
  // again and the modal does not come back on its own.
  await expect(b.getByTestId('join-congrats-continue')).toBeVisible()
  await b.getByTestId('join-congrats-continue').click()
  await expect(b.getByTestId('join-congrats')).toHaveCount(0)
  await expect(b.getByTestId('room-chip')).toContainText('Live')

  await expectZeroMealimeRequests(b)
  await expectZeroMealimeRequests(a)
  await ctxB.close()
  await ctxA.close()
})

test('a broken link toasts and never claims a join', async ({ page }) => {
  await blockExternalRequests(page)
  await page.goto('/?room=not-a-real-code')

  // An unusable code is refused by the client before it ever reaches the
  // relay (ADR-0021). The modal celebrates; it never excuses.
  await expect(page.getByTestId('join-congrats')).toHaveCount(0)
  await expect(page.getByTestId('toast')).toContainText('Live room unavailable', {
    timeout: 20_000,
  })
  await expect(page.getByTestId('room-chip')).toHaveCount(0)
  await expectZeroMealimeRequests(page)
})

test('the household auto-join opens NO modal — nobody handed that device a link', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await blockExternalRequests(page)

  // Save + join a room, then start a FRESH session: ADR-0019 re-joins the
  // saved code on its own, with no link involved. Congratulating that
  // would congratulate the device for something the user did not do.
  await page.goto('/settings')
  await page.getByTestId('household-room-input').fill('ember-willow-quartz')
  await page.getByTestId('household-room-join').click()
  await expect(page.getByTestId('room-chip')).toContainText('Live', { timeout: 20_000 })

  await page.evaluate(() => sessionStorage.clear())
  await page.reload()
  await expect(page.getByTestId('room-chip')).toContainText('Live', { timeout: 20_000 })
  await expect(page.getByTestId('household-toast')).toBeVisible()
  await expect(page.getByTestId('join-congrats')).toHaveCount(0)
  await expectZeroMealimeRequests(page)
})