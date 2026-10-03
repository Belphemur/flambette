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
  // It counts the household it just walked into. A is still connected, so
  // the joiner is the second one in — and the sentence says so rather than
  // reading like an empty room.
  await expect(b.getByTestId('join-congrats-peers')).toContainText('2', { timeout: 20_000 })

  // One CTA, and it really dismisses: the app underneath is reachable
  // again and the modal does not come back on its own.
  await expect(b.getByTestId('join-congrats-continue')).toBeVisible()
  await b.getByTestId('join-congrats-continue').click()
  await expect(b.getByTestId('join-congrats')).toHaveCount(0)
  await expect(b.getByTestId('room-chip')).toHaveAttribute('aria-label', /^Live room /)

  await expectZeroMealimeRequests(b)
  await expectZeroMealimeRequests(a)
  await ctxB.close()
  await ctxA.close()
})

test('the congrats modal counts a household of one honestly (ADR-0049 addendum)', async ({
  browser,
}) => {
  // A lone device following a link into a room nobody else is in. The
  // relay mints the room on the join (join-or-create, ADR-0026), so the
  // headcount is genuinely 1 — no second context needed.
  const ctxB = await browser.newContext()
  const b = await ctxB.newPage()
  await blockExternalRequests(b)
  await b.goto('/?room=ember-willow-quartz')
  await expect(b.getByTestId('join-congrats-peers')).toContainText('first one here', {
    timeout: 20_000,
  })
  // The count is a NUMBER, not a guess: the dot stays plain at one peer.
  await expect(b.getByTestId('room-chip-count')).toHaveCount(0)

  await expectZeroMealimeRequests(b)
  await ctxB.close()
})

test('joining from another tab with an EMPTY plan lands on the recipes list', async ({
  browser,
}) => {
  test.setTimeout(120_000)
  // A household with NO meals yet: A only creates the room (Settings →
  // New code), so there is nothing to inherit and the joiner's plan is
  // still empty after the snapshot lands.
  const ctxA = await browser.newContext()
  const a = await ctxA.newPage()
  await blockExternalRequests(a)
  await a.goto('/settings')
  await a.getByTestId('household-room-input').fill('amber-falcon-lantern')
  await a.getByTestId('household-room-join').click()
  await expect(a.getByTestId('room-chip')).toHaveAttribute('aria-label', /^Live room /, {
    timeout: 20_000,
  })

  // A joiner who is NOT on the recipes tab when the link lands, and who
  // has no plan of their own: /grocery is about a plan they have never
  // seen, and it would greet them with an empty list as if it were theirs.
  const ctxB = await browser.newContext()
  const b = await ctxB.newPage()
  await blockExternalRequests(b)
  await b.goto('/grocery')
  await expect(b.getByPlaceholder('Add an item not in the recipes…')).toBeVisible()
  await b.goto('/grocery?room=amber-falcon-lantern')

  await expect(b.getByTestId('join-congrats')).toBeVisible({ timeout: 20_000 })
  await b.getByTestId('join-congrats-continue').click()
  // The household's content is on the recipes list; that is where a
  // plan-less joiner belongs (ADR-0049 addendum).
  await expect(b).toHaveURL(/\/$/)
  await waitForCatalog(b)

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
  await expect(page.getByTestId('room-chip')).toHaveAttribute('aria-label', /^Live room /, { timeout: 20_000 })

  await page.evaluate(() => sessionStorage.clear())
  await page.reload()
  await expect(page.getByTestId('room-chip')).toHaveAttribute('aria-label', /^Live room /, { timeout: 20_000 })
  await expect(page.getByTestId('household-toast')).toBeVisible()
  await expect(page.getByTestId('join-congrats')).toHaveCount(0)
  await expectZeroMealimeRequests(page)
})