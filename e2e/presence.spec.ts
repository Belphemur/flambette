import { expect, test, type Page } from '@playwright/test'
import { blockExternalRequests, gotoTab, liveRoomCode } from './helpers'

/**
 * Room identity + live presence (ADR-0063).
 *
 * The header chip is a DOOR now: tapping it opens the roster sheet — a
 * PEOPLE list kept live by the relay (deduped by profile id, Guests for
 * profile-less old-version peers), with a quiet "you" marker on this
 * device's own row. Identity is a dedicated persisted slice; renames in
 * Settings push a `profile` frame and update every roster live.
 */

/** Start a household room from the Settings card and return its code. */
async function startHouseholdRoom(page: Page): Promise<string> {
  await page.goto('/settings')
  await page.getByTestId('household-room-new').click()
  return liveRoomCode(page)
}

test('chip tap opens the roster sheet: header count, own row marked you, canvas avatar', async ({
  page,
}) => {
  await blockExternalRequests(page)
  await page.goto('/')
  await startHouseholdRoom(page)

  const chip = page.getByTestId('room-chip')
  await expect(chip).toHaveAttribute('aria-expanded', 'false')
  await chip.click()

  const sheet = page.getByTestId('roster-sheet')
  await expect(sheet).toBeVisible()
  await expect(chip).toHaveAttribute('aria-expanded', 'true')
  // The relay's live headcount is the header sentence (ADR-0063).
  await expect(page.getByTestId('roster-heading')).toContainText('1 in room')
  // ONE person (this device), its own row marked with the quiet text.
  const rows = page.getByTestId('roster-row')
  await expect(rows).toHaveCount(1)
  await expect(page.getByTestId('roster-you')).toHaveText('you')
  // The row's avatar is the generated canvas, and the name renders Title
  // Case ("Brave Otter" shape — safe words, Title Case).
  await expect(rows.first().locator('canvas')).toHaveCount(1)
  const name = (await page.getByTestId('roster-name').textContent())!.trim()
  expect(name).toMatch(/^[A-Z][a-z]{2,9} [A-Z][a-z]{2,9}$/)

  // Close through the sheet's own control: the chip flips back.
  await page.getByTestId('roster-close').click()
  await expect(sheet).toHaveCount(0)
  await expect(chip).toHaveAttribute('aria-expanded', 'false')
})

test('roster lists a joined second device, live; rename in Settings updates it', async ({
  browser,
}) => {
  const ctxA = await browser.newContext()
  const a = await ctxA.newPage()
  await blockExternalRequests(a)
  const code = await startHouseholdRoom(a)

  // A opens the roster and KEEPS it open while B arrives.
  await a.getByTestId('room-chip').click()
  await expect(a.getByTestId('roster-sheet')).toBeVisible()

  const ctxB = await browser.newContext()
  const b = await ctxB.newPage()
  await blockExternalRequests(b)
  await b.goto(`/plan?room=${code}`)
  await expect(b.getByTestId('room-chip')).toHaveAttribute('aria-label', /^Live room /, {
    timeout: 10_000,
  })
  // The link join's congrats modal covers the page: acknowledge it before
  // tapping the chip (ADR-0049).
  await b.getByTestId('join-congrats-continue').click()

  // A's sheet lists TWO people (deduped by profile id — one device, one
  // row even with two tabs), with exactly one "you" marker: A's own.
  await expect(a.getByTestId('roster-row')).toHaveCount(2)
  await expect(a.getByTestId('roster-you')).toHaveCount(1)

  // B's own sheet marks B (not A) as "you".
  await b.getByTestId('room-chip').click()
  await expect(b.getByTestId('roster-row')).toHaveCount(2)
  await expect(b.getByTestId('roster-you')).toHaveCount(1)
  const bOwnRow = b.getByTestId('roster-row').filter({ has: b.getByTestId('roster-you') })
  const bOwnName = (await bOwnRow.getByTestId('roster-name').textContent())!.trim()

  // A's roster must NOT mark B's row — the marker follows the device.
  await expect(
    a.getByTestId('roster-row').filter({ hasText: bOwnName }).getByTestId('roster-you'),
  ).toHaveCount(0)
  // B closes its sheet (A's stays open — that is the one watching live).
  await b.getByTestId('roster-close').click()
  await expect(b.getByTestId('roster-sheet')).toHaveCount(0)

  // B renames in Settings → A's roster updates LIVE (the `profile` frame).
  await gotoTab(b, 'Settings')
  const input = b.getByTestId('identity-name-input')
  await input.fill('Test Ferret')
  await input.blur()
  await expect(
    a.getByTestId('roster-row').filter({ hasText: 'Test Ferret' }),
  ).toBeVisible({ timeout: 10_000 })
  // The rename did NOT add a row (same profile id) and did not move the
  // "you" markers.
  await expect(a.getByTestId('roster-row')).toHaveCount(2)
  await expect(a.getByTestId('roster-you')).toHaveCount(1)

  // Reopening B's sheet shows the rename in B's own roster too, with the
  // "you" marker still on B's (renamed) row — same profile id, new name.
  await b.getByTestId('room-chip').click()
  const bRenamedRow = b
    .getByTestId('roster-row')
    .filter({ hasText: 'Test Ferret' })
  await expect(bRenamedRow).toHaveCount(1)
  await expect(bRenamedRow.getByTestId('roster-you')).toHaveCount(1)
  // The avatar follows the name (it hashes the DISPLAY NAME): the renamed
  // row still renders its generated canvas.
  await expect(bRenamedRow.locator('canvas')).toHaveCount(1)

  await ctxA.close()
  await ctxB.close()
})

test('a backup round-trips the identity slice (ADR-0063 in ADR-0013)', async ({ page }) => {
  // Covered in depth by backup-restore.spec.ts's full round-trip (which
  // now lists identity.json, pins its UUID shape and asserts the SAME id
  // + name land in the restoring context's localStorage). This case pins
  // the live UI half: after joining (identity generated), the Settings
  // preview shows the avatar next to the field.
  await blockExternalRequests(page)
  await page.goto('/')
  await startHouseholdRoom(page)
  await gotoTab(page, 'Settings')
  await expect(page.getByTestId('identity-avatar').locator('canvas')).toHaveCount(1)
  const input = page.getByTestId('identity-name-input')
  // The field is seeded with the generated name (Title Case safe words).
  await expect(input).not.toBeEmpty()
  expect((await input.inputValue()).trim()).toMatch(/^[A-Z][a-z]{2,9} [A-Z][a-z]{2,9}$/)
})
