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
 * ADR-0042 reshaped the SURFACE only, to the single row the cook actually
 * uses: `name · minutes · presets · Start · X` sits above the footer
 * ALWAYS, with no `timer-add` disclosure and no panel to open. A timer the
 * recipe timed therefore arrives pre-filled with no tap at all, and
 * nothing about the §4 per-TYPE gate, the confirm, or the at-cap replace
 * question changed — only how many taps it takes to get there.
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

/**
 * Arm one preset, one tap. The row is always on screen, so there is no
 * disclosure to open first (ADR-0042) — and every step WAITS
 * (auto-retrying `expect`), never `count()`: the strip renders in the same
 * tick as the cooking dialog, so a `count()` probe can read 0 and click a
 * preset that is not there yet.
 */
async function armPreset(cooking: Locator, minutes: number) {
  const preset = cooking.getByTestId(`timer-preset-${minutes}`)
  await expect(preset).toBeVisible()
  await preset.click()
}

/**
 * Arm a NAMED timer: type the chip's label, then tap a preset. The draft
 * is cleared on arming, so the next call starts from an empty row — and
 * at the concurrent cap the add is refused into the "which one?" chips
 * instead, which is what keeps the loop in the cap test going.
 */
async function armNamed(cooking: Locator, label: string, minutes: number) {
  await expect(cooking.getByTestId('timer-name')).toBeVisible()
  await cooking.getByTestId('timer-name').fill(label)
  await armPreset(cooking, minutes)
}

/** Walk to the view whose first step is number `n` (1-based), either way. */
async function goToStepView(cooking: Locator, n: number) {
  for (let guard = 0; guard < 20; guard++) {
    const counter = (await cooking.getByTestId('step-counter').textContent()) ?? ''
    const at = Number(counter.match(/Steps? (\d+)/)![1])
    if (at === n) return
    await cooking.getByRole('button', { name: at < n ? /Next/ : /Previous/ }).click()
  }
  throw new Error(`never reached the view starting at step ${n}`)
}

/** Walk to the last step view, where Finish lives. */
async function goToLastStep(cooking: Locator) {
  const progress = await cooking.getByText(/Step 1 \/ (\d+)/).textContent()
  const total = Number(progress!.match(/Step 1 \/ (\d+)/)![1])
  const next = cooking.getByRole('button', { name: /Next/ })
  for (let i = 1; i < total; i++) await next.click()
  await expect(cooking.getByText(new RegExp(`Step ${total} \\/ ${total}`))).toBeVisible()
}

test('the row is always on screen, with no disclosure to open', async ({ page }) => {
  const cooking = await startCooking(page)

  // The strip and its add ROW are always there: setting a timer costs no
  // tap before the presets are reachable (ADR-0042). Before any timer is
  // armed there is nothing to list, so no manage button either.
  await expect(cooking.getByTestId('timer-strip')).toBeVisible()
  await expect(cooking.getByTestId('timer-add-row')).toBeVisible()
  await expect(chips(cooking)).toHaveCount(0)
  await expect(countdown(cooking)).toHaveCount(0)
  await expect(cooking.getByTestId('timer-name')).toBeVisible()
  await expect(cooking.getByTestId('timer-minutes')).toBeVisible()
  await expect(cooking.getByTestId('timer-preset-1')).toBeVisible()
  // Start has nothing to arm yet, and the disclosure is GONE.
  await expect(cooking.getByTestId('timer-confirm')).toBeDisabled()
  await expect(cooking.getByTestId('timer-add')).toHaveCount(0)
  await expect(cooking.getByTestId('timer-panel')).toHaveCount(0)
  await expect(cooking.getByTestId('timer-fab')).toHaveCount(0)
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
  // Back to a clean row — still open, so the next timer is one tap again.
  await expect(cooking.getByTestId('timer-name')).toBeVisible()
  await expect(cooking.getByTestId('timer-fab')).toHaveCount(0)
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

  // The fifth is refused into a question instead of a wider strip, asked
  // INLINE as chips in the row (ADR-0042) — no second panel.
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

test('a duration the recipe writes out is disclosed, re-offered, and only the confirm arms it', async ({ page }) => {
  const cooking = await startCookingRecipe(page, 5264)

  // The §4 pre-fill lands in the ROW, not in a separate chip: the range
  // is disclosed in the label ("Step 1" — the sentence itself names no
  // food) and never hidden. Authored as "15-18 minutes" (sidecar from
  // extract_timer_hints.py), so the LOWER bound is what is proposed.
  await expect(cooking.getByTestId('timer-name')).toHaveValue('Step 1 (of 15–18)')
  await expect(cooking.getByTestId('timer-minutes')).toHaveValue('15')
  await expect(cooking.getByTestId('timer-suggest')).toHaveCount(0)
  await expect(chips(cooking)).toHaveCount(0)

  // X clears the draft only — no timer is touched — and the step's
  // duration is then OFFERED as a chip, so clearing a field never costs
  // the cook the recipe's own suggestion.
  await cooking.getByTestId('timer-cancel').click()
  await expect(cooking.getByTestId('timer-name')).toHaveValue('')
  await expect(chips(cooking)).toHaveCount(0)
  const offer = cooking.getByTestId('timer-suggest')
  await expect(offer).toBeVisible()
  await expect(offer).toContainText('Step 1 (of 15–18)')
  await expect(offer).toContainText('15 min')

  // Tapping it PRE-FILLS — it never arms anything by itself (ADR-0041 §4).
  await offer.click()
  await expect(cooking.getByTestId('timer-name')).toHaveValue('Step 1 (of 15–18)')
  await expect(chips(cooking)).toHaveCount(0)

  await cooking.getByTestId('timer-confirm').click()
  await expect(chips(cooking)).toHaveCount(1)
  await expect(countdown(cooking)).toContainText('15:00')
  await expect(countdown(cooking)).toHaveAttribute('aria-label', /^Pause .*timer, 15:0\d left/)
  await expectZeroMealimeRequests(page)
})

test('the row pre-fills itself on a step the recipe timed (ADR-0041 §4)', async ({ page }) => {
  const cooking = await startCookingRecipe(page, 5264)

  // The sidecar resolves AFTER the step renders, and the row still fills
  // itself: nothing here waits for a gesture, and with ADR-0042 there is
  // no "Add timer" tap left to save either. Step 1 is authored
  // "15-18 minutes", so the LOWER bound is proposed and the range is
  // disclosed — the same values `timer-suggest` would have written.
  await expect(cooking.getByTestId('timer-add-row')).toBeVisible()
  await expect(cooking.getByTestId('timer-name')).toHaveValue('Step 1 (of 15–18)')
  await expect(cooking.getByTestId('timer-minutes')).toHaveValue('15')
  // The pre-fill IS the affordance here, so the offer chip adds nothing.
  await expect(cooking.getByTestId('timer-suggest')).toHaveCount(0)
  await expect(cooking.getByTestId('timer-add')).toHaveCount(0)
  await expect(chips(cooking)).toHaveCount(0)

  // One tap arms — the only tap the cook has to make.
  await cooking.getByTestId('timer-confirm').click()
  await expect(chips(cooking)).toHaveCount(1)
  await expect(countdown(cooking)).toContainText('15:00')
  await expect(countdown(cooking)).toHaveAttribute('aria-label', /^Pause .*timer, 15:0\d left/)
  await expectZeroMealimeRequests(page)
})

test('the pre-fill gate is per-TYPE: a live Oven never suppresses a Rice suggestion', async ({ page }) => {
  const cooking = await startCookingRecipe(page, 5264)

  // Step 7 is authored with a duration and names the food: "Shrimp
  // (of 2–3)". The row fills itself without waiting for a gesture.
  await goToStepView(cooking, 7)
  await expect(cooking.getByTestId('timer-name')).toHaveValue('Shrimp (of 2–3)')
  await cooking.getByTestId('timer-confirm').click()
  await expect(chips(cooking)).toHaveCount(1)

  // Step 11 is hinted too ("Step 11", 1 min) and is a DIFFERENT type from
  // the live Shrimp chip — a cook holding an oven and a pot of rice holds
  // both. So the row still pre-fills itself here.
  await goToStepView(cooking, 11)
  await expect(cooking.getByTestId('timer-name')).toHaveValue('Step 11 (of 1–2)')

  // Walk back to the Shrimp step: its OWN type is already counting down,
  // so there the fields stay empty and the chip speaks for itself. This
  // is the per-TYPE gate, not a per-recipe one.
  await goToStepView(cooking, 7)
  await expect(cooking.getByTestId('timer-name')).toHaveValue('')
  await expect(chips(cooking)).toHaveCount(1)

  // …and the refusal really is about the live timer, not about the step
  // running out of suggestions: the very same view still OFFERS it.
  await expect(cooking.getByTestId('timer-suggest')).toContainText('Shrimp')
  await expectZeroMealimeRequests(page)
})

test('navigating away from a suggested step clears the draft it filled', async ({ page }) => {
  const cooking = await startCookingRecipe(page, 5264)

  await expect(cooking.getByTestId('timer-name')).toHaveValue('Step 1 (of 15–18)')
  await cooking.getByRole('button', { name: /Next/ }).click()
  // Step 2 carries no authored duration, so nothing re-fills behind the
  // cook and no half-filled draft follows them either.
  await expect(cooking.getByTestId('timer-name')).toHaveValue('')
  await expect(cooking.getByTestId('timer-minutes')).toHaveValue('')
  await expect(cooking.getByTestId('timer-suggest')).toHaveCount(0)
  await expect(chips(cooking)).toHaveCount(0)
  await expectZeroMealimeRequests(page)
})

test('a recipe with no timer sidecar offers no suggestion', async ({ page }) => {
  // 10085 has NO <id>.timer.json sidecar at all — nothing in the catalog
  // was authored as an explicit duration — and its first view is pure prep
  // prose ("Wash and dry the fresh produce"). The missing sidecar is a
  // fact about the catalog, never an error: the suggestion affordance is
  // simply absent.
  const cooking = await startCookingRecipe(page, 10085)
  await expect(cooking.getByTestId('timer-add-row')).toBeVisible()
  await expect(cooking.getByTestId('timer-suggest')).toHaveCount(0)
  // The row still works: a missed suggestion never blocks a timer.
  await expect(cooking.getByTestId('timer-preset-5')).toBeVisible()
  await expectZeroMealimeRequests(page)
})

test('the recipe total cooking time is offered once, clearly labelled', async ({ page }) => {
  const cooking = await startCooking(page)

  // Labeled as the RECIPE TOTAL, not as this step's time.
  const suggestion = cooking.getByTestId('timer-preset-recipe')
  await expect(suggestion).toContainText('total')
  const minutes = Number((await suggestion.textContent())!.match(/(\d+)m total/)![1])
  expect(minutes).toBeGreaterThan(0)
  await suggestion.click()
  await expect.poll(() => secondsAt(cooking), { timeout: 15_000 }).toBeGreaterThan(minutes * 60 - 5)

  // The suggestion is a first-step affordance only — on the second step
  // view the row has it no more.
  await cooking.getByRole('button', { name: /Next/ }).click()
  await expect(cooking.getByTestId('timer-preset-5')).toBeVisible()
  await expect(cooking.getByTestId('timer-preset-recipe')).toHaveCount(0)
  await expectZeroMealimeRequests(page)
})

test('the manage button lists every armed timer and controls it from one place', async ({ page }) => {
  const cooking = await startCooking(page)

  await armNamed(cooking, 'Oven', 20)
  await armNamed(cooking, 'Rice', 5)
  await expect(cooking.getByTestId('timer-fab')).toBeVisible()

  await cooking.getByTestId('timer-fab').click()
  const sheet = page.getByTestId('timer-manage-sheet')
  await expect(sheet).toBeVisible()
  await expect(sheet).toContainText('Oven')
  await expect(sheet).toContainText('Rice')
  await expect(sheet.getByTestId('timer-manage-row')).toHaveCount(2)

  // Pausing from the sheet pauses the CHIP too — one state, two views of
  // it, never two competing controls.
  const firstToggle = sheet.locator('[data-test^="timer-manage-toggle-"]').first()
  await firstToggle.click()
  await expect(countdown(cooking, 0)).toHaveAttribute('aria-label', /^Start Oven timer, /)
  await expect(firstToggle).toHaveAttribute('aria-label', /^Start Oven timer, /)
  // The other timer never stopped.
  await expect(countdown(cooking, 1)).toHaveAttribute('aria-label', /^Pause Rice timer, /)

  // Escape closes the SHEET and nothing else: the cook session and the
  // live Rice timer are untouched, so a stray keypress can never throw
  // away a countdown.
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  await expect(cooking).toBeVisible()
  await expect(chips(cooking)).toHaveCount(2)

  // Reopening, clearing from the sheet removes the chip with it.
  await cooking.getByTestId('timer-fab').click()
  await expect(sheet).toBeVisible()
  await sheet.locator('[data-test^="timer-manage-clear-"]').first().click()
  await expect(chips(cooking)).toHaveCount(1)
  await expect(sheet.getByTestId('timer-manage-row')).toHaveCount(1)

  // The scrim closes it too, without a gesture on a timer.
  await page.getByTestId('timer-manage-scrim').click({ position: { x: 8, y: 8 } })
  await expect(sheet).toHaveCount(0)
  await expect(chips(cooking)).toHaveCount(1)
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