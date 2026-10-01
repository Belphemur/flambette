import { expect, test, type Locator, type Page } from '@playwright/test'
import {
  blockExternalRequests,
  expectZeroMealimeRequests,
  openFirstRecipeDetail,
  waitForCatalog,
} from './helpers'

/**
 * The global multi-timer strip (ADR-0041), which supersedes ADR-0038's
 * per-step placement (and keeps ADR-0020's countdown engine).
 *
 * ONE strip docked above the footer, visible from every step, one chip per
 * armed timer: a cook juggling an oven and a pot of rice needs both
 * countdowns live at once. Timers are independent (pause one, the other
 * keeps counting), they survive step navigation and a reload (state rides
 * the ui slice of STORE_SLICES), and a duration the RECIPE writes out is
 * offered as a suggestion that only ever pre-fills the confirm. The
 * countdown never touches the toast surface.
 *
 * `15682` ("Place eggs … cook for 8 minutes") and `5264` ("Cook until
 * liquid is absorbed, 15-18 minutes") are used for the suggestion cases:
 * the durations are authored in the frozen catalog, so the expectations
 * below pin the parser against real prose rather than a fixture.
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

/** Open the cooking session of a recipe by id (no plan entry needed). */
async function startCookingRecipe(page: Page, id: number) {
  await page.goto(`/cooking/${id}`)
  const cooking = page.getByRole('dialog', { name: /Cooking / })
  await expect(cooking).toBeVisible({ timeout: 15_000 })
  return cooking
}

/** Every armed chip, in strip order (oldest timer first). */
function chips(cooking: Locator): Locator {
  return cooking.locator('[data-test^="timer-chip-"]')
}

/** The countdown button of the `index`-th chip. */
function countdown(cooking: Locator, index = 0): Locator {
  return cooking.getByTestId('step-timer').nth(index)
}

/** Seconds left, parsed from a chip's aria-label ("…, 4:59 left"). */
async function secondsAt(cooking: Locator, index = 0): Promise<number> {
  const label = (await countdown(cooking, index).getAttribute('aria-label')) ?? ''
  const m = label.match(/(\d+):(\d{2}) left/)
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN
}

/** Open the add panel. The add affordance is only there while it is closed. */
async function openPanel(cooking: Locator) {
  await expect(cooking.getByTestId('timer-add')).toBeVisible()
  await cooking.getByTestId('timer-add').click()
  await expect(cooking.getByTestId('timer-panel')).toBeVisible()
}

/**
 * Arm one preset, one tap. Every step WAITS (auto-retrying `expect`),
 * never `count()`: the strip renders in the same tick as the cooking
 * dialog, so a `count()` probe can read 0 and click a preset that is not
 * there yet.
 */
async function armPreset(cooking: Locator, minutes: number) {
  await openPanel(cooking)
  const preset = cooking.getByTestId(`timer-preset-${minutes}`)
  await expect(preset).toBeVisible()
  await preset.click()
  // Arming closes the panel: the next timer starts from the add affordance.
  await expect(cooking.getByTestId('timer-panel')).toHaveCount(0)
}

/** Arm a NAMED timer: type the chip's label, then tap a preset. */
async function armNamed(cooking: Locator, label: string, minutes: number) {
  await openPanel(cooking)
  await cooking.getByTestId('timer-name').fill(label)
  const preset = cooking.getByTestId(`timer-preset-${minutes}`)
  await expect(preset).toBeVisible()
  await preset.click()
  // Arming closes the panel — EXCEPT at the concurrent cap, where the add
  // is refused into the "which one?" prompt and the panel stays put.
  if (!(await cooking.getByTestId('timer-replace-prompt').isVisible())) {
    await expect(cooking.getByTestId('timer-panel')).toHaveCount(0)
  }
}

/** Walk to the last step view, where Finish lives. */
async function goToLastStep(cooking: Locator) {
  const progress = await cooking.getByText(/Step 1 \/ (\d+)/).textContent()
  const total = Number(progress!.match(/Step 1 \/ (\d+)/)![1])
  const next = cooking.getByRole('button', { name: /Next/ })
  for (let i = 1; i < total; i++) await next.click()
  await expect(cooking.getByText(new RegExp(`Step ${total} \\/ ${total}`))).toBeVisible()
}

test('the strip offers a timer before any is armed', async ({ page }) => {
  const cooking = await startCooking(page)

  // The strip is always there; before the user asks for a timer it offers
  // exactly one thing and spreads no presets over the step.
  await expect(cooking.getByTestId('timer-strip')).toBeVisible()
  await expect(chips(cooking)).toHaveCount(0)
  await expect(countdown(cooking)).toHaveCount(0)
  await expect(cooking.getByTestId('timer-add')).toBeVisible()
  await expect(cooking.getByTestId('timer-preset-1')).toHaveCount(0)
  await expectZeroMealimeRequests(page)
})

test('a preset arms one chip that runs, stops and deletes', async ({ page }) => {
  const cooking = await startCooking(page)

  await armPreset(cooking, 1)
  await expect(chips(cooking)).toHaveCount(1)
  const timer = countdown(cooking)
  await expect(timer).toContainText('1:00')
  // The polite live region only announces on minute boundaries.
  await expect(timer).toHaveAttribute('aria-live', 'polite')
  await expect(timer).toContainText('1 minute left')

  // It counts down on its own (the wake lock keeps the screen on; nothing
  // is toasted).
  await expect.poll(() => secondsAt(cooking), { timeout: 15_000 }).toBeLessThan(58)
  await expect(page.getByTestId('toast')).toHaveCount(0)

  // One tap stops it and freezes the remaining time.
  await timer.click()
  await expect(timer).toHaveAttribute('aria-label', /^Start .* timer, /)
  const frozen = await secondsAt(cooking)
  await page.waitForTimeout(1500)
  expect(await secondsAt(cooking)).toBe(frozen)

  await cooking.getByTestId('timer-clear').click()
  await expect(chips(cooking)).toHaveCount(0)
  await expect(cooking.getByTestId('timer-add')).toBeVisible()
  await expectZeroMealimeRequests(page)
})

test('several timers run at once and stay independent', async ({ page }) => {
  const cooking = await startCooking(page)

  await armNamed(cooking, 'Oven', 20)
  await armNamed(cooking, 'Rice', 5)

  // Two chips, each with its own label and countdown.
  await expect(chips(cooking)).toHaveCount(2)
  await expect(chips(cooking).nth(0).getByTestId('chip-name')).toHaveText('Oven')
  await expect(chips(cooking).nth(1).getByTestId('chip-name')).toHaveText('Rice')
  await expect(countdown(cooking, 0)).toContainText('20:00')
  await expect(countdown(cooking, 1)).toContainText('5:00')

  // Pausing ONE leaves the other counting — they are separate jobs.
  await countdown(cooking, 0).click()
  await expect(countdown(cooking, 0)).toHaveAttribute('aria-label', /^Start Oven timer, /)
  await expect
    .poll(() => secondsAt(cooking, 1), { timeout: 15_000 })
    .toBeLessThan(290)
  const ovenPaused = await secondsAt(cooking, 0)
  await page.waitForTimeout(1200)
  expect(await secondsAt(cooking, 0)).toBe(ovenPaused)

  // Navigation moves the STEP, never the strip: both timers stay on screen.
  await cooking.getByRole('button', { name: /Next/ }).click()
  await expect(cooking.getByTestId('step-counter')).toBeVisible()
  await expect(chips(cooking)).toHaveCount(2)

  // …and so does a reload (ADR-0013 registry: the ui slice carries them).
  const riceBefore = await secondsAt(cooking, 1)
  await page.reload()
  const reopened = page.getByRole('dialog', { name: /Cooking / })
  await expect(reopened).toBeVisible({ timeout: 15_000 })
  await expect(chips(reopened)).toHaveCount(2)
  await expect(chips(reopened).nth(0).getByTestId('chip-name')).toHaveText('Oven')
  await expect.poll(() => secondsAt(reopened, 1), { timeout: 15_000 }).toBeLessThanOrEqual(riceBefore)
  // The play/pause state lives on a Lucide icon; the accessible name is the
  // contract (ADR-0027 icon stack) and it NAMES the timer.
  await expect(countdown(reopened, 0)).toHaveAttribute('aria-label', /^Start Oven timer, /)
  await expectZeroMealimeRequests(page)
})

test('a fifth timer asks which chip to replace, and nothing is dropped silently', async ({ page }) => {
  const cooking = await startCooking(page)

  for (const [label, minutes] of [
    ['Oven', 30],
    ['Rice', 15],
    ['Sauce', 10],
    ['Bread', 5],
  ] as const) {
    await armNamed(cooking, label, minutes)
  }
  await expect(chips(cooking)).toHaveCount(4)

  // The fifth is refused into a question instead of a wider strip.
  await armNamed(cooking, 'Too many', 5)
  await expect(cooking.getByTestId('timer-replace-prompt')).toBeVisible()
  await expect(chips(cooking)).toHaveCount(4)
  await expect(cooking.getByTestId('timer-preset-5')).toBeVisible()

  await cooking.locator('button[data-test^="timer-replace-"]').filter({ hasText: 'Rice' }).click()
  await expect(chips(cooking)).toHaveCount(4)
  await expect(chips(cooking).nth(1).getByTestId('chip-name')).toHaveText('Too many')
  await expect(cooking.getByTestId('timer-replace-prompt')).toHaveCount(0)
  await expectZeroMealimeRequests(page)
})

test('a duration the recipe writes out is offered, and only through the confirm', async ({ page }) => {
  const cooking = await startCookingRecipe(page, 5264)

  await openPanel(cooking)
  const suggest = cooking.getByTestId('timer-suggest')
  await expect(suggest).toBeVisible()
  // Authored as "15-18 minutes" (sidecar from extract_timer_hints.py):
  // the LOWER bound is suggested, the range is disclosed in the label
  // ("Step 1" — the sentence itself names no food), never hidden.
  await expect(suggest).toContainText('Step 1 (of 15–18)')
  await expect(suggest).toContainText('15 min')

  // Tapping it PRE-FILLS — it never arms anything by itself (ADR-0041 §4).
  await expect(chips(cooking)).toHaveCount(0)
  await suggest.click()
  await expect(cooking.getByTestId('timer-name')).toHaveValue('Step 1 (of 15–18)')
  await expect(cooking.getByTestId('timer-minutes')).toHaveValue('15')
  await expect(chips(cooking)).toHaveCount(0)

  await cooking.getByTestId('timer-confirm').click()
  await expect(chips(cooking)).toHaveCount(1)
  await expect(countdown(cooking)).toContainText('15:00')
  await expect(countdown(cooking)).toHaveAttribute('aria-label', /^Pause .*timer, 15:0\d left/)
  await expectZeroMealimeRequests(page)
})

test('a recipe with no timer sidecar offers no suggestion', async ({ page }) => {
  // 10085 has NO <id>.timer.json sidecar at all — nothing in the catalog
  // was authored as an explicit duration — and its first view is pure prep
  // prose ("Wash and dry the fresh produce"). The missing sidecar is a
  // fact about the catalog, never an error: the suggestion affordance is
  // simply absent.
  const cooking = await startCookingRecipe(page, 10085)
  await openPanel(cooking)
  await expect(cooking.getByTestId('timer-panel')).toBeVisible()
  await expect(cooking.getByTestId('timer-suggest')).toHaveCount(0)
  // The ladder still works: a missed suggestion never blocks a timer.
  await expect(cooking.getByTestId('timer-preset-5')).toBeVisible()
  await expectZeroMealimeRequests(page)
})

test('the recipe total cooking time is offered once, clearly labelled', async ({ page }) => {
  const cooking = await startCooking(page)

  // Labeled as the RECIPE TOTAL, not as this step's time.
  await openPanel(cooking)
  const suggestion = cooking.getByTestId('timer-preset-recipe')
  await expect(suggestion).toContainText('total')
  const minutes = Number((await suggestion.textContent())!.match(/(\d+)m total/)![1])
  expect(minutes).toBeGreaterThan(0)
  await suggestion.click()
  await expect.poll(() => secondsAt(cooking), { timeout: 15_000 }).toBeGreaterThan(minutes * 60 - 5)

  // The suggestion is a first-step affordance only — on the second step
  // view the ladder has it no more.
  await cooking.getByRole('button', { name: /Next/ }).click()
  await openPanel(cooking)
  await expect(cooking.getByTestId('timer-preset-5')).toBeVisible()
  await expect(cooking.getByTestId('timer-preset-recipe')).toHaveCount(0)
  await expectZeroMealimeRequests(page)
})

test('Finish asks before discarding a running timer', async ({ page }) => {
  const cooking = await startCooking(page)
  await goToLastStep(cooking)

  await armPreset(cooking, 5)
  await expect(countdown(cooking)).toContainText('5:00')

  // Declining the confirm keeps the cook session AND the timer.
  page.once('dialog', (d) => void d.dismiss())
  await cooking.getByRole('button', { name: /Finish/ }).click()
  await expect(cooking).toBeVisible()
  await expect(chips(cooking)).toHaveCount(1)

  // Accepting leaves — the toast is the finish confirmation, not a timer nag.
  page.once('dialog', (d) => void d.accept())
  await cooking.getByRole('button', { name: /Finish/ }).click()
  await expect(cooking).not.toBeVisible()
  await expect(page.getByTestId('toast').getByText('Enjoy!')).toBeVisible()
  await expectZeroMealimeRequests(page)
})

test('Finish names EVERY timer that is still running', async ({ page }) => {
  const cooking = await startCooking(page)

  // Two timers armed on the FIRST view, then Finish from the LAST one.
  await armNamed(cooking, 'Oven', 20)
  await armNamed(cooking, 'Rice', 15)
  await goToLastStep(cooking)
  // The strip is global: both chips are on screen at the last step.
  await expect(chips(cooking)).toHaveCount(2)

  page.once('dialog', (d) => {
    expect(d.message()).toContain('Oven')
    expect(d.message()).toContain('Rice')
    void d.dismiss()
  })
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
  // run out with the strip in view.
  await goToLastStep(cooking)

  await armPreset(cooking, 1)
  await expect(countdown(cooking)).toContainText('1:00')
  await expect
    .poll(() => secondsAt(cooking), { timeout: 90_000, intervals: [1000, 2500, 2500, 5000] })
    .toBe(0)
  await expect(countdown(cooking)).toContainText('0:00')
  await expect(countdown(cooking)).toHaveAttribute('aria-label', /^Start .* timer, /)
  expect(await secondsAt(cooking)).toBe(0)

  // Finish needs NO confirmation for an expired timer.
  await cooking.getByRole('button', { name: /Finish/ }).click()
  await expect(cooking).not.toBeVisible()
  await expect(page.getByTestId('toast').getByText('Enjoy!')).toBeVisible()
  await expectZeroMealimeRequests(page)
})

test('the header close button routes through the timer confirmation (qodo 4128519620)', async ({ page }) => {
  const cooking = await startCooking(page)
  await armNamed(cooking, 'Oven', 20)
  await expect(countdown(cooking)).toContainText('20:00')

  page.once('dialog', (d) => void d.dismiss())
  await cooking.getByRole('button', { name: 'Close cooking mode' }).click()
  await expect(cooking).toBeVisible()

  page.once('dialog', (d) => void d.accept())
  await cooking.getByRole('button', { name: 'Close cooking mode' }).click()
  await expect(cooking).not.toBeVisible()
  await expectZeroMealimeRequests(page)
})

test('mark as cooked also asks before discarding a running timer', async ({ page }) => {
  // ADR-0034: the mark is available from the FIRST step, and a mid-cook
  // mark keeps you cooking — it is the same timer gate Finish runs.
  const cooking = await startCooking(page)
  await expect(cooking.getByTestId('mark-cooked')).toBeVisible()

  await armNamed(cooking, 'Oven', 20)
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