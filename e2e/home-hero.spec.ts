import { expect, test } from '@playwright/test'
import { blockExternalRequests, expectZeroMealimeRequests, liveRoomCode, waitForCatalog } from './helpers'

/**
 * The home hero (ADR-0078): `/` is a statement of what the app is, never
 * the catalog grid. The recipes list moved to `/recipes` (route name
 * `recipes` unchanged); the hero route hides the bottom nav (the header
 * STAYS, Q2), routes into the catalog through "Start planning", and
 * opens the household modal from a REAL `room.create()` against the
 * relay — the code shown is the code the relay honoured, never a mock
 * (`olive-basin-saffron` is a rejected render fiction).
 */

test.beforeEach(async ({ page }) => {
  await blockExternalRequests(page)
})

test.afterEach(async ({ page }) => {
  await expectZeroMealimeRequests(page)
})

test('the hero renders and the catalog grid does not', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('home-hero')).toBeVisible()

  // The hero's own content: eyebrow, headline with the tomato emphasis,
  // the owner-ruled literal, the accepted no-connection phrasing.
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Plan dinner together.')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('No account needed.')
  await expect(page.getByTestId('home-hero')).toContainText('2,500+ hand-curated recipes')
  await expect(page.getByTestId('home-hero')).toContainText('works even with no connection')
  // The count NEVER claims catalog accuracy, and "offline" is not the wording.
  await expect(page.getByTestId('home-hero')).not.toContainText('2,759')
  await expect(page.getByTestId('home-hero')).not.toContainText(/offline/i)

  // NOT the catalog grid.
  await expect(page.getByTestId('recipe-card-link').first()).toHaveCount(0)

  // Shell chrome per Q2: header present, bottom nav absent.
  await expect(page.locator('[data-test="app-shell"] > header')).toHaveCount(1)
  await expect(page.locator('nav[aria-label="Main navigation"]')).toHaveCount(0)
})

test('"Start planning" routes to the recipes list', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('hero-start-planning').click()
  await expect(page).toHaveURL(/\/recipes$/)
  await waitForCatalog(page)
})

test('the empty-state "Browse recipes" buttons land on the catalog, not the hero', async ({
  page,
}) => {
  // ADR-0078 moved the catalog off `/` — the hero lives there now — so
  // the Plan/Grocery/History empty states must route to /recipes
  // directly: one press reaches the catalog, no second hop through the
  // hero.
  for (const path of ['/plan', '/grocery', '/history'] as const) {
    await page.goto(path)
    await page.getByRole('button', { name: 'Browse recipes' }).click()
    await expect(page).toHaveURL(/\/recipes$/)
    await waitForCatalog(page)
  }
})

test('the Recipes tab keeps its highlight at the canonical /recipes/ URL', async ({ page }) => {
  // /recipes/ (trailing slash) is the canonical form production serves —
  // Cloudflare 308s to it and nginx serves it as the directory index —
  // so the active-tab check keys on the ROUTE NAME, never on a strict
  // path comparison: everyone arriving from search, the sitemap, a
  // bookmark or a reload still sees the tab marked and aria-current set.
  await page.goto('/recipes/')
  await waitForCatalog(page)
  const tab = page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Recipes' })
  await expect(tab).toHaveAttribute('aria-current', 'page')
  await expect(tab).toHaveClass(/text-chrome-accent/)
  // The tinted backplate is a child span of the tab (DESIGN.md Navigation).
  await expect(tab.locator('span.bg-chrome-backplate')).toBeVisible()
})

test('the household modal flow against the relay: create → code → copy link → browse', async ({
  page,
}) => {
  await page.goto('/')

  // Create rolls the code CLIENT-side (ADR-0021) and dials the relay.
  await page.getByTestId('hero-create-household').click()
  const modal = page.getByTestId('household-modal')
  await expect(modal).toBeVisible({ timeout: 15_000 })

  // The REAL code, in JetBrains Mono — three words, not the render's mock.
  const code = page.getByTestId('household-code')
  await expect(code).toHaveText(/^[a-z]+-[a-z]+-[a-z]+$/)
  await expect(code).not.toHaveText('olive-basin-saffron')
  expect(await code.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/mono/i)

  // The relay must CONFIRM the room before the link is shareable: the
  // copy affordance stays disabled while the dial is unanswered (a
  // code_taken re-roll would make the displayed code a refused one), so
  // the pending hint clears before the copy press (ADR-0023's verified
  // write shares a link that WORKS).
  await expect(page.getByTestId('household-copy-link')).toBeEnabled({ timeout: 15_000 })
  await expect(page.getByTestId('household-pending')).toHaveCount(0)

  // Copy room link: the verified-write path ALWAYS says something
  // (ADR-0023) — success toast or the hand-copy fallback, never silence.
  await page.getByTestId('household-copy-link').click()
  await expect(
    page.getByTestId('share-room-toast').or(page.getByTestId('toast')).first(),
  ).toBeVisible()

  // The modal's ONE filled intent closes it into the catalog.
  await page.getByTestId('household-browse-recipes').click()
  await expect(page).toHaveURL(/\/recipes$/)
  await waitForCatalog(page)
  await expect(page.getByTestId('household-modal')).toHaveCount(0)
})

test('closing the household modal restores the hero', async ({ page }) => {
  // The relay is reachable here (the config starts one), so this is the
  // happy dismissal path: Escape closes the modal and the hero is intact.
  // A FAILED create is covered by the room-error watcher (ADR-0019: toast,
  // never block) — the unit-level decision table pins its semantics.
  await page.goto('/')
  await page.getByTestId('hero-create-household').click()
  await expect(page.getByTestId('household-modal')).toBeVisible({ timeout: 15_000 })
  // Closing the modal (Escape) restores the hero exactly.
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('home-hero')).toBeVisible()
})

test('the create button re-joins a SAVED household instead of rolling a new code', async ({
  page,
}) => {
  // A device that already adopted a household (ADR-0019) must never get a
  // fresh code from the hero — that would orphan the household it belongs
  // to. The button reconnects to the saved room; the modal shows the REAL
  // saved code, adopted synchronously by `join()`.
  await page.goto('/settings')
  const code = 'quartz-lantern-otter'
  await page.getByTestId('household-room-input').fill(code)
  await page.getByTestId('household-room-join').click()
  await expect(page.getByTestId('household-room-status')).toContainText(code, {
    timeout: 20_000,
  })

  // Back on the hero: the button now READS "Join your household" — the
  // label and the press share ONE source of truth — and the press
  // reconnects: the code in the modal is the SAVED one, byte for byte,
  // not a fresh roll.
  await page.goto('/')
  await expect(page.getByTestId('hero-create-household')).toHaveAccessibleName(
    'Join your household',
  )
  await page.getByTestId('hero-create-household').click()
  await expect(page.getByTestId('household-modal')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('household-code')).toHaveText(code)
})

test('a device LIVE in a room reopens THAT room — never a re-roll', async ({ page }) => {
  // The owner's repro: a device standing in a room whose code was never
  // persisted as the household room (a Plan-tab room, or a session
  // resume). The store resumes from sessionStorage and dials the relay,
  // so the header chip goes LIVE — but `ui.householdRoom` is empty, and
  // a persisted-setting-only membership test would label the button
  // "Create a household" and re-roll on press, orphaning the room the
  // device is standing in. Membership is room.inRoom OR the saved
  // setting; the live room wins the press.
  const code = 'quartz-lantern-otter'
  await page.addInitScript(
    ([key, value]) => sessionStorage.setItem(key!, value!),
    ['mealime-planner:v1:room-code', code] as const,
  )
  await page.goto('/')

  // LIVE in the room (the chip's aria-label names it, ADR-0049), and the
  // saved household setting is still empty.
  const chipCode = await liveRoomCode(page)
  expect(chipCode).toBe(code)
  await expect(page.getByTestId('hero-create-household')).toHaveAccessibleName(
    'Join your household',
  )

  // The press reopens the room we are standing in — the SAME code, and
  // the live socket is untouched (the chip keeps counting this device).
  await page.getByTestId('hero-create-household').click()
  await expect(page.getByTestId('household-modal')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('household-code')).toHaveText(code)
  expect(await liveRoomCode(page)).toBe(code)
  // A live room is already confirmed: sharing is available at once.
  await expect(page.getByTestId('household-copy-link')).toBeEnabled()
})

test('the hero flips with the theme via tokens, not dark: pairs', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('home-hero')).toBeVisible()

  const read = () =>
    page.evaluate(() => {
      // A value-strip card is a raised surface ON the page canvas.
      const card = document.querySelector<HTMLElement>('[data-test="home-hero"] .bg-surface-raised')!
      return {
        card: getComputedStyle(card).backgroundColor,
        body: getComputedStyle(document.body).backgroundColor,
      }
    })

  const light = await read()
  // Warm Culinary Paper: #FBF8F2 canvas, #F4EFE6 card.
  expect(light.body).toBe('rgb(251, 248, 242)')
  expect(light.card).toBe('rgb(244, 239, 230)')

  await page.getByRole('button', { name: 'Switch to dark mode' }).click()
  await expect(page.locator('html')).toHaveClass(/dark/)
  const dark = await read()
  // The SAME element resolves the flip — no dark: utility was named.
  expect(dark.body).toBe('rgb(23, 19, 16)')
  expect(dark.card).toBe('rgb(36, 28, 24)')
  expect(dark.card).not.toBe(light.card)
})

test.describe('mobile hero (Stitch "Home Page Hero (Mobile)")', () => {
  // Phone-shaped on BOTH projects (the Pixel 7 device viewport): the
  // stacking below is viewport-gated, so forcing the viewport keeps the
  // assertions deterministic no matter which project runs the file.
  test.use({ viewport: { width: 412, height: 915 } })

  test('CTAs stack full-width and the value strip is a single column', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('home-hero')).toBeVisible()

    // The CTA row is a COLUMN of full-width buttons below sm (640px).
    const ctaRow = page.getByTestId('hero-start-planning').locator('xpath=..')
    expect(await ctaRow.evaluate((el) => getComputedStyle(el).flexDirection)).toBe('column')
    const startBtn = page.getByTestId('hero-start-planning')
    const createBtn = page.getByTestId('hero-create-household')
    // Full-width on the phone: both buttons span the row's content box.
    expect(await startBtn.evaluate((el) => el.offsetWidth)).toBeGreaterThan(300)
    const startBox = await startBtn.boundingBox()
    const createBox = await createBtn.boundingBox()
    expect(createBox!.y).toBeGreaterThan(startBox!.y + startBox!.height - 1)

    // The value strip is ONE column on the phone (never a 3-col grid).
    const strip = page
      .locator('[data-test="home-hero"] section')
      .filter({ hasText: 'No account. Ever.' })
    await expect(strip).toHaveCount(1)
    const cols = await strip.first().evaluate((el) => getComputedStyle(el).gridTemplateColumns)
    expect(cols.split(' ').length).toBe(1)

    // The stacked cards stay centred within a phone-width column.
    const cards = page.locator('[data-test="home-hero"] .max-w-\\[400px\\]')
    await expect(cards).toBeVisible()
    const cardBox = await cards.boundingBox()
    expect(cardBox!.width).toBeLessThanOrEqual(400)
  })

  test('the household illustration keeps the demo code on mobile', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('home-hero')).toBeVisible()

    // The static marketing illustration (ADR-0078 Decision 5): the demo
    // code with the redacted first word, NO live state, on BOTH
    // breakpoints.
    const card = page.getByTestId('hero-household-card')
    const demo = page.getByTestId('hero-demo-code')
    await expect(demo).toContainText('-basin-saffron')
    await expect(demo).not.toHaveText(/^[a-z]+-[a-z]+-[a-z]+$/)
    // No "live" claim in the ILLUSTRATION (the value-strip copy may say
    // the plan "syncs live" — that is a feature description, not a
    // fake-live badge).
    await expect(card).not.toContainText(/\blive\b/i)
    await expect(card).toContainText('Your household')
  })
})