import { expect, test, type Page } from '@playwright/test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { unzipStore } from '../src/lib/zip'
import {
  blockExternalRequests,
  expectZeroMealimeRequests,
  waitForCatalog,
} from './helpers'

/**
 * Timer completion alerts (ADR-0081 timer-alert amendment).
 *
 * When a step timer reaches zero the device alerts per the SETTINGS: a
 * synthesized two-tone chime (Web Audio) and/or a vibration pattern,
 * ON TOP of the polite live-region announcement. Both toggles default
 * ON and live in the ui slice (`mealime-planner:v1:ui`), so a reload and
 * a backup round-trip carry them. They are DEVICE-LOCAL by decision —
 * never the room payload.
 *
 * The AudioContext path is guarded: headless runs have no audio device
 * and take the silent branch without failing, so these tests assert the
 * VIBRATION channel (feature-patched per test) and the announcement.
 */

test.beforeEach(async ({ page }) => {
  await blockExternalRequests(page)
  // Feature-patch navigator.vibrate BEFORE any app code runs: record
  // every call so a completion can be asserted called / not called.
  await page.addInitScript(() => {
    const w = window as unknown as { __vibrateCalls?: unknown[] }
    w.__vibrateCalls = []
    Object.defineProperty(navigator, 'vibrate', {
      configurable: true,
      value: (pattern: number | number[]) => {
        w.__vibrateCalls!.push(pattern)
        return true
      },
    })
  })
  await page.goto('/recipes')
  await waitForCatalog(page)
})

async function gotoSettings(page: Page) {
  await page.goto('/settings')
  await expect(page.getByTestId('timer-alerts-card')).toBeVisible()
}

test('both toggles default ON, persist a reload, and travel through a backup', async ({ page }) => {
  await gotoSettings(page)
  const sound = page.getByTestId('timer-alert-sound')
  const vibrate = page.getByTestId('timer-alert-vibrate')
  await expect(sound).toBeChecked()
  await expect(vibrate).toBeChecked()

  // The owner's ruling recorded on the card: this is THIS device's config.
  await expect(page.getByTestId('timer-alerts-card')).toContainText('THIS device')

  // Turn sound OFF; it survives a reload via the ui slice.
  await sound.click()
  await expect(sound).not.toBeChecked()
  await page.reload()
  await expect(page.getByTestId('timer-alert-sound')).not.toBeChecked()
  await expect(page.getByTestId('timer-alert-vibrate')).toBeChecked()
  const uiBlob = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('mealime-planner:v1:ui') ?? '{}'),
  )
  expect(uiBlob.timerAlertSound).toBe(false)
  expect(uiBlob.timerAlertVibrate).toBe(true)

  // Backup round-trip: export carries the toggles…
  const downloadPromise = page.waitForEvent('download')
  await page.getByTestId('export-settings').click()
  const download = await downloadPromise
  const path = join(tmpdir(), `mymealime-timer-alerts-${Date.now()}.zip`)
  await download.saveAs(path)
  const entries = unzipStore(readFileSync(path)) as Map<string, Uint8Array>
  const settings = JSON.parse(new TextDecoder().decode(entries.get('settings.json')!))
  expect(settings.timerAlertSound).toBe(false)
  expect(settings.timerAlertVibrate).toBe(true)

  // …and importing restores them: flip BOTH toggles locally, then bring
  // the archive back — the archived values win.
  await page.getByTestId('timer-alert-sound').click()
  await page.getByTestId('timer-alert-vibrate').click()
  await expect(page.getByTestId('timer-alert-sound')).toBeChecked()
  await expect(page.getByTestId('timer-alert-vibrate')).not.toBeChecked()
  await page.setInputFiles('[data-test=import-settings-input]', {
    name: 'backup.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(readFileSync(path)),
  })
  await page.getByTestId('import-settings-confirm').click()
  await expect(page.getByTestId('toast')).toContainText('Backup restored')
  // The restore wrote the archived values back.
  await expect(page.getByTestId('timer-alert-sound')).not.toBeChecked()
  await expect(page.getByTestId('timer-alert-vibrate')).toBeChecked()
  await expectZeroMealimeRequests(page)
})

test('a finished timer buzzes when vibration is ON and stays silent when OFF — the announcement always runs', async ({ page }) => {
  test.setTimeout(240_000)
  const cooking = await startCooking(page)

  // Vibration OFF first: a completion must NOT call navigator.vibrate…
  await gotoSettings(page)
  await page.getByTestId('timer-alert-vibrate').click()
  await expect(page.getByTestId('timer-alert-vibrate')).not.toBeChecked()

  await page.goto('/recipes')
  await waitForCatalog(page)
  await cooking2(page)
  await armPreset1(page)
  await expectCompletion(page)
  expect(await vibrateCalls(page)).toEqual([])

  // …the announcement channel still ran: the chip reads "Time's up".
  await expect(
    page.getByRole('dialog', { name: /Cooking / }).getByTestId('step-timer').last(),
  ).toContainText("Time's up")

  // Now vibration ON: the very same completion buzzes with the pattern.
  await gotoSettings(page)
  await page.getByTestId('timer-alert-vibrate').click()
  await expect(page.getByTestId('timer-alert-vibrate')).toBeChecked()

  await page.goto('/recipes')
  await waitForCatalog(page)
  await cooking2(page)
  // The expired timer from the first leg must NOT re-alert on reopening:
  // seeding is silent (ADR-0081 amendment — a timer that finished before
  // the view mounted never buzzes).
  expect(await vibrateCalls(page)).toEqual([])
  await armPreset1(page)
  await expectCompletion(page)
  // The completion HOST ticks on its own 1 s cadence — its fire() can land
  // up to a second after the chip's 500 ms tick first shows "Time's up" —
  // so the vibration is polled, never read once.
  let calls: unknown[] = []
  await expect
    .poll(
      async () => {
        calls = await vibrateCalls(page)
        return calls.length
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0)
  expect(calls[0]).toEqual([200, 140, 200, 140, 400])
  await expectZeroMealimeRequests(page)
})

/* ---------- helpers ---------- */

async function startCooking(page: Page) {
  await page.goto('/cooking/10085')
  const cooking = page.getByRole('dialog', { name: /Cooking / })
  await expect(cooking).toBeVisible({ timeout: 15_000 })
  return cooking
}

/** After a settings detour, re-enter the cook session (deep link). */
async function cooking2(page: Page) {
  await page.goto('/cooking/10085')
  await expect(page.getByRole('dialog', { name: /Cooking / })).toBeVisible({ timeout: 15_000 })
}

async function armPreset1(page: Page) {
  const cooking = page.getByRole('dialog', { name: /Cooking / })
  await expect(cooking.getByTestId('timer-preset-1')).toBeVisible()
  await cooking.getByTestId('timer-preset-1').click()
  // The NEWEST chip (an earlier leg may have left an expired one).
  await expect(cooking.getByTestId('step-timer').last()).toContainText('1:00')
}

/** Wait out the 1-minute timer and its completion alert. */
async function expectCompletion(page: Page) {
  const cooking = page.getByRole('dialog', { name: /Cooking / })
  await expect
    .poll(
      async () => {
        const label = (await cooking.getByTestId('step-timer').last().getAttribute('aria-label')) ?? ''
        const m = label.match(/(\d+):(\d{2}) left/)
        return m ? Number(m[1]) * 60 + Number(m[2]) : -1
      },
      { timeout: 95_000, intervals: [2000, 5000, 5000, 10_000] },
    )
    .toBe(0)
}

async function vibrateCalls(page: Page): Promise<unknown[]> {
  return page.evaluate(() => (window as unknown as { __vibrateCalls?: unknown[] }).__vibrateCalls ?? [])
}
