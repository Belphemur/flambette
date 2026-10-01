import { expect, test } from '@playwright/test'
import { blockExternalRequests, expectZeroMealimeRequests, waitForCatalog } from './helpers'

/**
 * The kitchen identity: the theme-flip token layer, the responsive
 * container, the recipe/detail composition and the nav hover contract
 * (ADR-0036).
 *
 * Four rules shape these specs:
 *
 *  - Pixels are not asserted (no screenshot baselines in this repo). The
 *    computed contract is: resolved background/text colour, container
 *    width, column count, transition property, resolved transform.
 *  - DARK MODE IS THE SAME MARKUP. Because `@theme` variables are
 *    re-pointed under `.dark`, one assertion per surface covers both
 *    themes: the values must CHANGE to the documented pair, and nothing
 *    may leak the light value onto the espresso surface.
 *  - The grid is pinned at six widths, including 320 (the narrowest
 *    phone worth supporting) and 1920 (where the container cap is the
 *    whole story).
 *  - A HOVER state is a mouse affordance: it must exist on the Desktop
 *    project and be provably ABSENT on the touch project.
 */

const DESKTOP_VIEWPORT = { width: 1440, height: 900 }

/** DESIGN.md `spacing.container` / `spacing.reading`. */
const CONTAINER_PX = 1100
const READING_PX = 672

/** DESIGN.md Layout: the grid steps at 360 / 720 / 1024, capped at 4. */
const GRID_COLUMNS: { width: number; columns: number }[] = [
  { width: 320, columns: 1 },
  { width: 360, columns: 2 },
  { width: 412, columns: 2 },
  { width: 768, columns: 3 },
  { width: 1024, columns: 4 },
  { width: 1920, columns: 4 },
]

/** The first row of cards, measured from the grid element itself. */
async function firstRowCount(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => {
    const grid = document.querySelector<HTMLElement>('[data-test="recipe-grid"]')!
    const cards = Array.from(grid.children) as HTMLElement[]
    if (cards.length === 0) return 0
    const top = Math.round(cards[0].getBoundingClientRect().top)
    return cards.filter((c) => Math.abs(Math.round(c.getBoundingClientRect().top) - top) < 2).length
  })
}

test.describe('the container', () => {
  test('it is fluid, capped at 1100px, and never overflows the window', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'presentation contract, asserted on desktop')
    await blockExternalRequests(page)
    for (const width of [1024, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/')
      await waitForCatalog(page)
      const box = (await page.locator('[data-test="app-shell"]').boundingBox())!
      expect(box.width).toBeLessThanOrEqual(width)
      expect(box.width).toBeLessThanOrEqual(CONTAINER_PX)
      if (width >= CONTAINER_PX + 64) expect(box.width).toBeCloseTo(CONTAINER_PX, 0)
      const navBox = (await page.locator('nav[aria-label="Main navigation"] > div').boundingBox())!
      expect(navBox.width).toBeCloseTo(box.width, 0)
    }
  })

  test('cooking keeps the 672px reading measure, not the browse shell', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'presentation contract, asserted on desktop')
    await page.setViewportSize(DESKTOP_VIEWPORT)
    await blockExternalRequests(page)
    await page.goto('/')
    await waitForCatalog(page)

    // Plan -> a planned recipe -> its sheet -> Start cooking.
    await page.locator('[data-test="recipe-card-link"]').first().click()
    await page.getByRole('dialog').getByTestId('start-cooking').click()
    const cooking = page.getByRole('dialog')
    await expect(cooking).toBeVisible()

    // The dialog OVERLAY is full-width by design; the reading column
    // inside it is what must stay at 672px (DESIGN.md Cooking).
    const column = (await cooking.locator('div.max-w-reading').first().boundingBox())!
    expect(column.width).toBeLessThanOrEqual(READING_PX)
    expect(column.width).toBeGreaterThan(READING_PX - 2) // exactly 672 when the window allows
    await expectZeroMealimeRequests(page)
  })
})

test.describe('the food grid', () => {
  test('it steps 1 / 2 / 3 / 4 columns and never overflows its container', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'presentation contract, asserted on desktop')
    await blockExternalRequests(page)
    for (const step of GRID_COLUMNS) {
      await page.setViewportSize({ width: step.width, height: 900 })
      await page.goto('/')
      await waitForCatalog(page)
      expect(await firstRowCount(page), `columns at ${step.width}px`).toBe(step.columns)

      // No card may escape the grid: overflow here is what makes a
      // responsive redesign feel broken at an in-between width.
      const overflow = await page.evaluate(() => {
        const grid = document.querySelector<HTMLElement>('[data-test="recipe-grid"]')!
        return grid.scrollWidth - grid.clientWidth
      })
      expect(overflow, `grid overflow at ${step.width}px`).toBeLessThanOrEqual(1)
    }
  })

  test('a card states its type, energy and time — and NO sodium', async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'presentation contract, asserted on desktop')
    await page.setViewportSize(DESKTOP_VIEWPORT)
    await blockExternalRequests(page)
    await page.goto('/')
    await waitForCatalog(page)

    const card = page.locator('[data-test="recipe-card"]').first()
    await expect(card.getByTestId('card-energy')).toBeVisible()
    await expect(card.getByTestId('card-time')).toBeVisible()
    // The type icon carries its own accessible name; there is no
    // redundant word beside it (DESIGN.md Components).
    const typeIcon = card.locator('[data-test^="recipe-type-"] [role="img"]')
    if ((await typeIcon.count()) > 0) {
      await expect(typeIcon).toHaveAttribute('aria-label', /.+/)
    }
    // Sodium belongs to the recipe's nutrition section, not to a card.
    await expect(card).not.toContainText(/mg/)
  })

  test('the whole card is one link, and focus shows a ring on it', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'presentation contract, asserted on desktop')
    await page.setViewportSize(DESKTOP_VIEWPORT)
    await blockExternalRequests(page)
    await page.goto('/')
    await waitForCatalog(page)

    const card = page.locator('[data-test="recipe-card"]').first()
    await expect(card.getByTestId('recipe-card-link')).toHaveCount(1)
    await card.getByTestId('recipe-card-link').focus()
    const outline = await card
      .getByTestId('recipe-card-link')
      .evaluate((el) => getComputedStyle(el, '::after').outlineWidth)
    expect(outline).not.toBe('0px')
  })
})

test.describe('the theme flip', () => {
  test('surfaces resolve to the documented light AND dark values', async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'presentation contract, asserted on desktop')
    await page.setViewportSize(DESKTOP_VIEWPORT)
    await blockExternalRequests(page)
    await page.goto('/')
    await waitForCatalog(page)

    const read = () =>
      page.evaluate(() => {
        const card = document.querySelector<HTMLElement>('[data-test="recipe-card"]')!
        const s = getComputedStyle(card)
        return { card: s.backgroundColor, body: getComputedStyle(document.body).backgroundColor }
      })

    const light = await read()
    // Cream `#FFF8F0` body, white `#FFFFFF` card.
    expect(light.body).toBe('rgb(255, 248, 240)')
    expect(light.card).toBe('rgb(255, 255, 255)')

    await page.getByRole('button', { name: 'Switch to dark mode' }).click()
    await expect(page.locator('html')).toHaveClass(/dark/)
    const dark = await read()
    // Espresso `#171310` body, raised `#241C18` card — the SAME element,
    // proving no component had to name a `dark:` variant.
    expect(dark.body).toBe('rgb(23, 19, 16)')
    expect(dark.card).toBe('rgb(36, 28, 24)')
    expect(dark.card).not.toBe(light.card)
    await expectZeroMealimeRequests(page)
  })

  test('the active nav tab wears the brand tint, not a filled brand slab', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'presentation contract, asserted on desktop')
    await page.setViewportSize(DESKTOP_VIEWPORT)
    await blockExternalRequests(page)
    await page.goto('/')
    await waitForCatalog(page)

    const tab = page.locator('nav[aria-label="Main navigation"] button', { hasText: 'Recipes' })
    const backplate = tab.locator('span.rounded-full')
    await expect(backplate).toBeVisible()
    // DESIGN.md `primary-tint` #FBEAE5 — a warm tint, and NOT the tomato.
    expect(await backplate.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
      'rgb(251, 234, 229)',
    )
    expect(await tab.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(142, 44, 23)')
  })
})

test.describe('the recipe detail', () => {
  test('the photo sits beside the intro and actions on desktop', async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'presentation contract, asserted on desktop')
    await page.setViewportSize(DESKTOP_VIEWPORT)
    await blockExternalRequests(page)
    await page.goto('/')
    await waitForCatalog(page)

    await page.locator('[data-test="recipe-card-link"]').first().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    const hero = dialog.locator('[data-test="detail-hero"]')
    const photo = (await hero.locator('figure').boundingBox())!
    const actions = (await dialog.locator('[data-test="detail-actions"]').boundingBox())!
    const title = (await dialog.getByRole('heading', { level: 2 }).first().boundingBox())!
    // Two columns: the introduction and the action panel sit BESIDE the
    // photograph, so both start to the right of it. (The action panel
    // sits under the intro, not level with the photo — the column, not
    // the y, is the contract.)
    expect(title.x).toBeGreaterThan(photo.x + photo.width - 2)
    expect(actions.x).toBeGreaterThan(photo.x + photo.width - 2)
    expect(Math.abs(actions.x - title.x)).toBeLessThan(2)

    const ingredients = dialog.getByRole('heading', { name: /Ingredients/ })
    const instructions = dialog.getByRole('heading', { name: /^Instructions$/ })
    const a = (await ingredients.boundingBox())!
    const b = (await instructions.boundingBox())!
    expect(Math.abs(a.y - b.y)).toBeLessThan(40)
    expect(b.x).toBeGreaterThan(a.x)
    await expectZeroMealimeRequests(page)
  })

  test('Start cooking is the only filled tomato, and Add to plan is secondary', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'presentation contract, asserted on desktop')
    await page.setViewportSize(DESKTOP_VIEWPORT)
    await blockExternalRequests(page)
    await page.goto('/')
    await waitForCatalog(page)
    await page.locator('[data-test="recipe-card-link"]').first().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    const start = dialog.getByTestId('start-cooking')
    const add = dialog.getByTestId('add-to-plan')
    // Filled tomato + on-brand text = 6.0:1 on BOTH surfaces.
    expect(await start.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
      'rgb(179, 56, 31)',
    )
    expect(await start.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(255, 255, 255)')
    // Secondary is an outline, so it must NOT carry a tomato fill.
    expect(await add.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(
      'rgb(179, 56, 31)',
    )
    // 44px minimum hit target (DESIGN.md Shapes).
    expect((await start.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  })

  test('sodium appears in the nutrition section, in its own hue', async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'presentation contract, asserted on desktop')
    await page.setViewportSize(DESKTOP_VIEWPORT)
    await blockExternalRequests(page)
    await page.goto('/')
    await waitForCatalog(page)
    await page.locator('[data-test="recipe-card-link"]').first().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByTestId('nutrition')).toBeVisible()

    const sodium = dialog.getByTestId('nutrition-sodium')
    await expect(sodium).toBeVisible()
    // The iris hue #4F46E5, and never the tomato.
    expect(await sodium.locator('svg').evaluate((el) => getComputedStyle(el).color)).toBe(
      'rgb(79, 70, 229)',
    )
    // Nutrition comes AFTER the actions, so the primary action is met
    // before the reader is asked to consider a macro split.
    const a = (await dialog.getByTestId('detail-actions').boundingBox())!
    const n = (await dialog.getByTestId('nutrition').boundingBox())!
    expect(n.y).toBeGreaterThan(a.y)
  })
})

test.describe('pinned widths in BOTH themes', () => {
  test('surfaces resolve correctly at 320/360/412/768/1440/1920', async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'presentation contract, asserted on desktop')
    await blockExternalRequests(page)
    // (width -> expected grid columns), the DESIGN.md Layout steps.
    const steps: [number, number][] = [
      [320, 1],
      [360, 2],
      [412, 2],
      [768, 3],
      [1440, 4],
      [1920, 4],
    ]
    const EXPECTED: Record<string, { body: string; card: string }> = {
      light: { body: 'rgb(255, 248, 240)', card: 'rgb(255, 255, 255)' },
      dark: { body: 'rgb(23, 19, 16)', card: 'rgb(36, 28, 24)' },
    }

    for (const [width, columns] of steps) {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/')
      await waitForCatalog(page)
      for (const theme of ['light', 'dark'] as const) {
        if (theme === 'dark') {
          await page.getByRole('button', { name: 'Switch to dark mode' }).click()
          expect(
            await page.evaluate(() => document.documentElement.classList.contains('dark')),
          ).toBe(true)
        }
        const surfaces = await page.evaluate(() => {
          const card = document.querySelector<HTMLElement>('[data-test="recipe-card"]')!
          return {
            body: getComputedStyle(document.body).backgroundColor,
            card: getComputedStyle(card).backgroundColor,
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          }
        })
        // The espresso theme must be the SAME markup resolved, never a
        // component that only "looks right" in one theme.
        expect(surfaces.body, `body at ${width}px ${theme}`).toBe(EXPECTED[theme].body)
        expect(surfaces.card, `card at ${width}px ${theme}`).toBe(EXPECTED[theme].card)
        expect(surfaces.overflow, `horizontal overflow at ${width}px ${theme}`).toBeLessThanOrEqual(1)
      }
      expect(await firstRowCount(page), `columns at ${width}px`).toBe(columns)
      // Back to light for the next width, without reloading.
      await page.getByRole('button', { name: 'Switch to light mode' }).click()
    }
  })

  test('200% zoom of a 1280px window reflows instead of clipping', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'presentation contract, asserted on desktop')
    await blockExternalRequests(page)
    // A real 200% browser zoom halves the CSS viewport and doubles the
    // device pixel ratio — which is exactly this configuration, so the
    // reflow is exercised for real rather than simulated with `zoom`.
    await page.setViewportSize({ width: 640, height: 450 })
    await page.goto('/')
    await waitForCatalog(page)

    // Nothing scrolls sideways, and the shell fits the narrowed window.
    const fit = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      shell: document.querySelector<HTMLElement>('[data-test="app-shell"]')!.getBoundingClientRect()
        .width,
    }))
    expect(fit.overflow).toBeLessThanOrEqual(1)
    expect(fit.shell).toBeLessThanOrEqual(640)

    // The five nav tabs still fit without horizontal navigation scrolling.
    const nav = await page.locator('nav[aria-label="Main navigation"] > div').boundingBox()
    expect(nav!.width).toBeLessThanOrEqual(640)

    // And the primary action on the recipe detail is still reachable.
    await page.locator('[data-test="recipe-card-link"]').first().click()
    const start = page.getByRole('dialog').getByTestId('start-cooking')
    await expect(start).toBeVisible()
    const box = (await start.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(640)
    expect(box.height).toBeGreaterThanOrEqual(44)
  })
})

test.describe('computed accessibility', () => {
  test('text meets 4.5:1 against its REAL background in both themes', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'presentation contract, asserted on desktop')
    await page.setViewportSize(DESKTOP_VIEWPORT)
    await blockExternalRequests(page)
    await page.goto('/')
    await waitForCatalog(page)

    for (const theme of ['light', 'dark'] as const) {
      if (theme === 'dark') await page.getByRole('button', { name: 'Switch to dark mode' }).click()
      expect(
        await page.evaluate((t) => document.documentElement.classList.contains('dark'), theme),
        `theme ${theme} not applied`,
      ).toBe(theme === 'dark')

      // A selected filter chip, so the tinted selected state is measured
      // too — that is the pairing a naive token check always misses.
      await page.getByRole('button', { name: /^Vegetarian/ }).first().click()
      await page.waitForTimeout(200)

      // WCAG relative luminance and ratio, computed IN THE PAGE from the
      // values the browser actually resolved — never from token
      // constants, which is what a source-string assertion would do.
      const samples = await page.evaluate(() => {
        function lum(c: number[]): number {
          const [r, g, b] = c.map((v) => {
            const s = v / 255
            return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
          })
          return 0.2126 * r + 0.7152 * g + 0.0722 * b
        }
        function ratio(a: number[], b: number[]): number {
          const [hi, lo] = [lum(a), lum(b)].sort((p, q) => q - p)
          return (hi + 0.05) / (lo + 0.05)
        }
        function parse(color: string): number[] | null {
          const m = /rgba?\(([^)]+)\)/.exec(color)
          if (!m) return null
          const p = m[1].split(',').map((n) => parseFloat(n))
          if (p.length > 3 && p[3] < 0.5) return null // transparent proves nothing
          return [p[0], p[1], p[2]]
        }
        const out: { name: string; ratio: number }[] = []
        const measure = (name: string, el: Element | null | undefined) => {
          if (!el) return
          const fg = parse(getComputedStyle(el).color)
          let node: Element | null = el
          let bg: number[] | null = null
          while (node && !bg) {
            bg = parse(getComputedStyle(node).backgroundColor)
            node = node.parentElement
          }
          if (!fg || !bg) return
          out.push({ name, ratio: Number(ratio(fg, bg).toFixed(2)) })
        }
        const buttons = Array.from(document.querySelectorAll('button'))
        const chip = (selected: boolean) =>
          buttons.find(
            (b) =>
              b.className.includes('rounded-full') &&
              b.className.includes('border') &&
              b.className.includes('bg-brand-tint') === selected,
          )
        measure('card title', document.querySelector('[data-test="recipe-card-link"]'))
        measure('selected chip', chip(true))
        measure('idle chip', chip(false))
        measure('nav tab label', document.querySelector('nav[aria-label="Main navigation"] button'))
        measure(
          'result count',
          Array.from(document.querySelectorAll('p')).find((p) =>
            /^\d+ recipes?$/.test(p.textContent!.trim()),
          ),
        )
        measure('search field label', document.querySelector('input[type="search"], input[placeholder]'))
        return out
      })

      expect(samples.length, `no contrast samples in ${theme}`).toBeGreaterThanOrEqual(5)
      for (const s of samples) {
        // Body text and chip labels are all "normal" text (>= 14px,
        // non-bold) so AA asks 4.5:1 — no token gets an exemption.
        expect(s.ratio, `${s.name} in ${theme}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  test('the primary action is 6:1 filled tomato in BOTH themes', async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'presentation contract, asserted on desktop')
    await page.setViewportSize(DESKTOP_VIEWPORT)
    await blockExternalRequests(page)
    await page.goto('/')
    await waitForCatalog(page)
    await page.locator('[data-test="recipe-card-link"]').first().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    const start = dialog.getByTestId('start-cooking')

    for (const theme of ['light', 'dark'] as const) {
      if (theme === 'dark') await page.getByRole('button', { name: 'Switch to dark mode' }).click()
      const pair = await start.evaluate((el) => ({
        fg: getComputedStyle(el).color,
        bg: getComputedStyle(el).backgroundColor,
      }))
      expect(pair.bg, `start-cooking fill in ${theme}`).toBe('rgb(179, 56, 31)')
      expect(pair.fg).toBe('rgb(255, 255, 255)')
    }
  })
})

test.describe('nav icon hover (pointer)', () => {
  test('the nav icon lifts 2px and tints to the brand token', async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'pointer affordance only')
    await page.setViewportSize(DESKTOP_VIEWPORT)
    await blockExternalRequests(page)
    await page.goto('/')
    await waitForCatalog(page)

    const tab = page.locator('nav[aria-label="Main navigation"] button', { hasText: 'Plan' })
    const icon = tab.locator('svg.nav-tab-icon')
    await expect(icon).toBeVisible()

    const idle = await icon.evaluate((el) => {
      const s = getComputedStyle(el)
      return {
        transform: s.transform,
        transition: s.transitionProperty,
        duration: s.transitionDuration,
        color: s.color,
      }
    })
    expect(idle.transform).toBe('none')
    expect(idle.transition).toContain('transform')
    expect(idle.transition).toContain('color')
    expect(idle.duration).toContain('0.15s')

    await tab.hover()
    // Poll until the transform has actually SETTLED on the final -2px
    // translation. Polling only for "started animating" would read the
    // element mid-transition, where the matrix is an intermediate value.
    await expect
      .poll(async () =>
        icon.evaluate((el) => {
          const t = getComputedStyle(el).transform
          const m = /matrix\(([^)]+)\)/.exec(t)
          return m === null ? null : Math.round(Number(m![1].split(',')[5]))
        }),
      )
      .toBe(-2)
    const hovered = await icon.evaluate((el) => {
      const s = getComputedStyle(el)
      return { transform: s.transform, color: s.color }
    })
    expect(hovered.transform).toContain('matrix')
    expect(hovered.transform).toContain('-2')
    expect(hovered.color).not.toBe(idle.color)
  })

  test('reduced motion drops the lift and keeps the tint', async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'pointer affordance only')
    await page.setViewportSize(DESKTOP_VIEWPORT)
    await blockExternalRequests(page)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/')
    await waitForCatalog(page)

    const tab = page.locator('nav[aria-label="Main navigation"] button', { hasText: 'Plan' })
    const icon = tab.locator('svg.nav-tab-icon')
    const idle = await icon.evaluate((el) => ({
      transition: getComputedStyle(el).transitionProperty,
      color: getComputedStyle(el).color,
    }))
    expect(idle.transition).toBe('color')

    await tab.hover()
    const state = await icon.evaluate((el) => {
      const s = getComputedStyle(el)
      return { transform: s.transform, color: s.color }
    })
    expect(state.transform).toBe('none')
    expect(state.color).not.toBe(idle.color)
  })
})

test.describe('touch viewport never gets the hover affordance', () => {
  test('no hover transition, no lift, and the phone card layout is intact', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile !== true, 'touch project only')
    await blockExternalRequests(page)
    await page.goto('/')
    await waitForCatalog(page)

    const icon = page.locator('nav[aria-label="Main navigation"] svg.nav-tab-icon').first()
    await expect(icon).toBeVisible()
    const state = await icon.evaluate((el) => {
      const s = getComputedStyle(el)
      return { transform: s.transform, duration: s.transitionDuration }
    })
    // The rule is inside `@media (hover: hover)`, which never matches a
    // touch viewport: the CSS default (`all` at 0s) is still in force, so
    // there is no 150ms animation, no transform and no stuck hover tint.
    expect(state.duration).toBe('0s')
    expect(state.transform).toBe('none')

    // A Pixel 7 is 412px wide: two columns, and the shell never overflows.
    expect(await firstRowCount(page)).toBe(2)
    const shell = (await page.locator('[data-test="app-shell"]').boundingBox())!
    expect(shell.width).toBeLessThanOrEqual(page.viewportSize()!.width)
    await expectZeroMealimeRequests(page)
  })
})