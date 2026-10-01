import { expect, test, type Locator, type Page } from '@playwright/test'
import {
  blockExternalRequests,
  expectZeroMealimeRequests,
  openFirstRecipeDetail,
  waitForCatalog,
} from './helpers'

/**
 * Phase 18 — per-step timers in the cooking view (ADR-0020).
 *
 * One timer per step VIEW (a "Meanwhile" pair shares one timer), preset
 * ladder + the recipe's own total cooking time, running across step
 * navigation and across a reload (state rides the ui slice of
 * STORE_SLICES). The countdown never touches the toast surface.
 */

test.beforeEach(async ({ page }) => {
  await blockExternalRequests(page)
  await page.goto('/')
  await waitForCatalog(page)
})

/** Add the first recipe to the plan and enter cooking mode. */
async function startCooking(page: Page) {
  await openFirstRecipeDetail(page)
  const sheet = page.getByRole('dialog')
  await sheet.getByRole('button', { name: /Add to plan|Update in plan/ }).click()
  await sheet.getByRole('button', { name: 'Start cooking' }).click()
  const cooking = page.getByRole('dialog', { name: /Cooking / })
  await expect(cooking).toBeVisible()
  return cooking
}

/** Seconds left, parsed from the timer's aria-label ("… , 4:59 left"). */
async function timerSeconds(cooking: Locator) {
  const label = (await cooking.getByTestId('step-timer').getAttribute('aria-label')) ?? ''
  const m = label.match(/(\d+):(\d{2}) left/)
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN
}

/** Reveal an unarmed step's preset ladder (ADR-0038's collapsed row). */
async function openAddRow(cooking: Locator) {
  await cooking.getByTestId('timer-add').click()
  await expect(cooking.getByTestId('timer-preset-1')).toBeVisible()
}

/**
 * Arm a preset from the step's own row (ADR-0038). An UNARMED step shows
 * only the "Add timer" affordance, so the ladder has to be opened first;
 * an armed step already shows it, and there is no add affordance to
 * click. One helper so no test can silently arm through a stale path.
 */
async function armPreset(cooking: Locator, minutes: number) {
  if (await cooking.getByTestId('timer-add').count()) await openAddRow(cooking)
  await cooking.getByTestId(`timer-preset-${minutes}`).click()
}

test('a preset starts one countdown that runs, stops and clears', async ({ page }) => {
  const cooking = await startCooking(page)

  // The row is always there; before the user asks for a timer it offers
  // exactly one thing, and the ladder is NOT spread over the step.
  const row = cooking.getByTestId('step-timer-row')
  await expect(row).toBeVisible()
  await expect(cooking.getByTestId('step-timer')).toHaveCount(0)
  await expect(cooking.getByTestId('timer-add')).toBeVisible()
  await expect(cooking.getByTestId('timer-preset-1')).toHaveCount(0)

  await armPreset(cooking, 1)
  const timer = cooking.getByTestId('step-timer')
  await expect(timer).toBeVisible()
  await expect(timer).toContainText('1:00')
  // The polite live region only announces on minute boundaries.
  await expect(timer).toHaveAttribute('aria-live', 'polite')
  await expect(timer).toContainText('1 minute left')

  // It counts down on its own (the wake lock keeps the screen on; nothing
  // is toasted).
  await expect
    .poll(() => timerSeconds(cooking), { timeout: 15_000 })
    .toBeLessThan(58)
  await expect(page.getByTestId('toast')).toHaveCount(0)

  // One tap stops it and freezes the remaining time.
  await timer.click()
  await expect(timer).toHaveAttribute('aria-label', /^Start timer, /)
  const frozen = await timerSeconds(cooking)
  await page.waitForTimeout(1500)
  expect(await timerSeconds(cooking)).toBe(frozen)

  await cooking.getByTestId('timer-clear').click()
  await expect(cooking.getByTestId('step-timer')).toHaveCount(0)
  // Clearing puts the add affordance back; the ladder stays open so a
  // re-arm is one tap, but the countdown and the add row never coexist.
  await expect(cooking.getByTestId('timer-add')).toBeVisible()
  await expectZeroMealimeRequests(page)
})

test('the recipe total cooking time is offered once, clearly labelled', async ({ page }) => {
  const cooking = await startCooking(page)

  // Labeled as the RECIPE TOTAL, not as this step's time.
  const suggestion = cooking.getByTestId('timer-preset-recipe')
  await openAddRow(cooking)
  await expect(suggestion).toContainText('total')
  const minutes = Number((await suggestion.textContent())!.match(/(\d+)m total/)![1])
  expect(minutes).toBeGreaterThan(0)
  await suggestion.click()
  await expect
    .poll(() => timerSeconds(cooking), { timeout: 15_000 })
    .toBeGreaterThan(minutes * 60 - 5)

  // The suggestion is a first-step affordance only — on the second step
  // view the row is a bare add affordance.
  await cooking.getByRole('button', { name: /Next/ }).click()
  await expect(cooking.getByTestId('timer-add')).toBeVisible()
  await expect(cooking.getByTestId('timer-preset-recipe')).toHaveCount(0)
  await expectZeroMealimeRequests(page)
})

test('timers are per-step, and a step without one offers only the add row', async ({ page }) => {
  const cooking = await startCooking(page)

  await armPreset(cooking, 5)
  await expect(cooking.getByTestId('step-timer')).toContainText('5:00')

  // Step 2 has its OWN timer state, and that state is "none": the row is
  // there, it says Add timer, and it carries no countdown.
  await cooking.getByRole('button', { name: /Next/ }).click()
  await expect(cooking.getByTestId('step-timer-row')).toBeVisible()
  await expect(cooking.getByTestId('step-timer')).toHaveCount(0)
  await expect(cooking.getByTestId('timer-add')).toBeVisible()
  await expect(cooking.getByTestId('timer-add')).toHaveAttribute('aria-expanded', 'false')
  await expect(cooking.getByTestId('timer-preset-5')).toHaveCount(0)

  // Arming step 2 leaves step 1's timer alone — one timer per VIEW.
  await armPreset(cooking, 1)
  await expect(cooking.getByTestId('step-timer')).toContainText('1:00')
  await cooking.getByRole('button', { name: /Previous/ }).click()
  await expect(cooking.getByTestId('step-timer')).toContainText('5:00')
  await expect
    .poll(() => timerSeconds(cooking), { timeout: 15_000 })
    .toBeLessThan(300)
  await expectZeroMealimeRequests(page)
})

test('a running timer survives step navigation and a reload', async ({ page }) => {
  const cooking = await startCooking(page)

  await armPreset(cooking, 3)
  await expect(cooking.getByTestId('step-timer')).toContainText('3:00')

  // Navigate away: that view has its own (empty) timer, and back again
  // the countdown has kept running.
  await cooking.getByRole('button', { name: /Next/ }).click()
  await expect(cooking.getByTestId('step-timer')).toHaveCount(0)
  await expect(cooking.getByTestId('timer-add')).toBeVisible()
  await cooking.getByRole('button', { name: /Previous/ }).click()
  await expect
    .poll(() => timerSeconds(cooking), { timeout: 15_000 })
    .toBeLessThan(180)

  // A reload mid-cook resumes honestly from the persisted timer (ADR-0013
  // registry: the ui slice carries stepTimers).
  const before = await timerSeconds(cooking)
  await page.reload()
  const reopened = page.getByRole('dialog', { name: /Cooking / })
  await expect(reopened).toBeVisible({ timeout: 15_000 })
  await expect.poll(() => timerSeconds(reopened), { timeout: 15_000 }).toBeLessThanOrEqual(before)
  // The play/pause state now lives on a Lucide icon; the accessible name
  // is the contract (ADR-0027 icon stack).
  await expect(reopened.getByTestId('step-timer')).toHaveAttribute('aria-label', /^(Pause|Start) timer, /)
  await expectZeroMealimeRequests(page)
})

test('Finish asks before discarding a running timer', async ({ page }) => {
  const cooking = await startCooking(page)
  const progress = await cooking.getByText(/Step 1 \/ (\d+)/).textContent()
  const total = Number(progress!.match(/Step 1 \/ (\d+)/)![1])
  const next = cooking.getByRole('button', { name: /Next/ })
  for (let i = 1; i < total; i++) await next.click()
  await expect(cooking.getByText(new RegExp(`Step ${total} \\/ ${total}`))).toBeVisible()

  await armPreset(cooking, 5)
  await expect(cooking.getByTestId('step-timer')).toContainText('5:00')

  // Declining the confirm keeps the cook session AND the timer.
  page.once('dialog', (d) => void d.dismiss())
  await cooking.getByRole('button', { name: /Finish/ }).click()
  await expect(cooking).toBeVisible()
  await expect(cooking.getByTestId('step-timer')).toBeVisible()

  // Accepting leaves — the toast is the finish confirmation, not a timer nag.
  page.once('dialog', (d) => void d.accept())
  await cooking.getByRole('button', { name: /Finish/ }).click()
  await expect(cooking).not.toBeVisible()
  await expect(page.getByTestId('toast').getByText('Enjoy!')).toBeVisible()
  await expectZeroMealimeRequests(page)
})

test('Finish prompts for a timer left on ANOTHER step (qodo 4128519620)', async ({ page }) => {
  const cooking = await startCooking(page)

  // Timer on step 1, then navigate to the LAST step and finish there.
  await armPreset(cooking, 5)
  await expect(cooking.getByTestId('step-timer')).toContainText('5:00')
  const progress = await cooking.getByText(/Step 1 \/ (\d+)/).textContent()
  const total = Number(progress!.match(/Step 1 \/ (\d+)/)![1])
  const next = cooking.getByRole('button', { name: /Next/ })
  for (let i = 1; i < total; i++) await next.click()
  await expect(cooking.getByText(new RegExp(`Step ${total} \\/ ${total}`))).toBeVisible()

  page.once('dialog', (d) => void d.dismiss())
  await cooking.getByRole('button', { name: /Finish/ }).click()
  await expect(cooking).toBeVisible()

  page.once('dialog', (d) => void d.accept())
  await cooking.getByRole('button', { name: /Finish/ }).click()
  await expect(cooking).not.toBeVisible()
  await expect(page.getByTestId('toast').getByText('Enjoy!')).toBeVisible()
  await expectZeroMealimeRequests(page)
})

test('an expired timer does not block Finish and offers Restart (qodo 4128519641)', async ({ page }) => {
  // The 1-minute preset must genuinely run out.
  test.setTimeout(120_000)
  const cooking = await startCooking(page)

  // Finish lives on the LAST step — go there first, then let the timer
  // run out on the step Finish is on.
  const progress = await cooking.getByText(/Step 1 \/ (\d+)/).textContent()
  const total = Number(progress!.match(/Step 1 \/ (\d+)/)![1])
  const next = cooking.getByRole('button', { name: /Next/ })
  for (let i = 1; i < total; i++) await next.click()
  await expect(cooking.getByText(new RegExp(`Step ${total} \\/ ${total}`))).toBeVisible()

  // Shortest preset, then outlast it. At 0:00 the timer button offers a
  // restart — pausing a finished countdown made no sense.
  await armPreset(cooking, 1)
  await expect(cooking.getByTestId('step-timer')).toContainText('1:00')
  await expect
    .poll(() => timerSeconds(cooking), { timeout: 90_000, intervals: [1000, 2500, 2500, 5000] })
    .toBe(0)
  await expect(cooking.getByTestId('step-timer')).toContainText('0:00')
  await expect(cooking.getByTestId('step-timer')).toHaveAttribute('aria-label', /^Start timer, /)
  expect(await timerSeconds(cooking)).toBe(0)

  // Finish needs NO confirmation for an expired timer.
  await cooking.getByRole('button', { name: /Finish/ }).click()
  await expect(cooking).not.toBeVisible()
  await expect(page.getByTestId('toast').getByText('Enjoy!')).toBeVisible()
  await expectZeroMealimeRequests(page)
})

test('the header close button routes through the timer confirmation (qodo 4128519620)', async ({ page }) => {
  const cooking = await startCooking(page)
  await armPreset(cooking, 5)
  await expect(cooking.getByTestId('step-timer')).toContainText('5:00')

  page.once('dialog', (d) => void d.dismiss())
  await cooking.getByRole('button', { name: 'Close cooking mode' }).click()
  await expect(cooking).toBeVisible()

  page.once('dialog', (d) => void d.accept())
  await cooking.getByRole('button', { name: 'Close cooking mode' }).click()
  await expect(cooking).not.toBeVisible()
  await expectZeroMealimeRequests(page)
})


test('mark as cooked also asks before discarding a running timer', async ({ page }) => {
  // ADR-0034: the mark is available from the FIRST step now, and a
  // mid-cook mark keeps you cooking — it is the same timer gate Finish
  // runs, applied to the mark.
  const cooking = await startCooking(page)
  await expect(cooking.getByTestId('mark-cooked')).toBeVisible()

  await armPreset(cooking, 5)
  page.once('dialog', (d) => void d.dismiss())
  await cooking.getByTestId('mark-cooked').click()
  await expect(cooking).toBeVisible()
  // The toast is the assertion surface: the button ALSO reads "Marked as
  // cooked" once recorded, so a bare getByText would match both.
  await expect(page.getByTestId('toast')).toHaveCount(0)
  await expect(cooking.getByTestId('mark-cooked')).toBeEnabled()

  page.once('dialog', (d) => void d.accept())
  await cooking.getByTestId('mark-cooked').click()
  await expect(page.getByTestId('toast')).toContainText('Marked as cooked')
  // Recording the cook mid-way does not end the cook…
  await expect(cooking).toBeVisible()
  // …and the session records ONE cook: the button now reports it and
  // stops inviting a second one (ADR-0034).
  await expect(cooking.getByTestId('mark-cooked')).toContainText('Marked as cooked')
  await expect(cooking.getByTestId('mark-cooked')).toBeDisabled()
  await expectZeroMealimeRequests(page)
})
