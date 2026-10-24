# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: onboarding.spec.ts >> Onboarding tour (ADR-0097) >> welcome step shows as a centered card with X and Next
- Location: e2e/onboarding.spec.ts:26:3

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: locator('main article').first()
Expected: visible
Timeout: 15000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" locator('main article').first() with timeout 15000ms
  - waiting for locator('main article').first()

```

```yaml
- banner:
  - button "Home": Flambette
  - searchbox "Search recipes or ingredients"
  - button "Search tips"
  - button "What's new in version v2.12.0-feat/home-is-recipes-for-returning-users-b292846": v2.12.0-feat/home-is-recipes-for-returning-users-b292846
  - button "Switch to dark mode"
- main:
  - text: Meal planning for your household
  - heading "Plan dinner together. No account needed." [level=1]
  - paragraph: Flambette runs right in your browser. Pick from over 2,500 hand-curated recipes, build a waste-aware plan and one grocery list — and share it with your household using a three-word code. No sign-up, no email, nothing to remember.
  - button "Start planning"
  - button "Create a household"
  - text: Your data stays on your devices. Only a household room syncs — your plan, through your own three-word code.
  - img "Sheet-pan halloumi and roasted vegetables"
  - heading "Sheet-pan halloumi & peppers" [level=3]
  - paragraph: 35 min · 6 servings
  - text: Your household A S -basin-saffron
  - paragraph: A sample, not a real room — Create a household to get yours.
  - heading "No account. Ever." [level=2]
  - paragraph: Open the app and start. Nothing to register, nothing tracked.
  - heading "One household, one plan" [level=2]
  - paragraph: A three-word code syncs the plan, grocery list and cooked history live.
  - heading "2,500+ hand-curated recipes" [level=2]
  - paragraph: A real editor picked every recipe. The catalog ships with the app — browsing works even with no connection.
```

# Test source

```ts
  1   | import { readFileSync } from 'node:fs'
  2   | import { dirname, resolve } from 'node:path'
  3   | import { fileURLToPath } from 'node:url'
  4   | import { expect, type Page } from '@playwright/test'
  5   | import { classifyDiets, type DietId } from '../src/lib/dietFilter'
  6   | 
  7   | /** Repo root, resolved from this file (e2e/helpers.ts). */
  8   | const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  9   | 
  10  | /** Hosts the app must never contact — it is fully offline. */
  11  | const FORBIDDEN_HOSTS = /(^|\.)mealime\.com$/
  12  | 
  13  | /**
  14  |  * Install route interception that fails any request to mealime.com hosts and
  15  |  * records the attempts. Assert with `expectZeroMealimeRequests(page)`.
  16  |  */
  17  | export async function blockExternalRequests(page: Page): Promise<void> {
  18  |   const attempts = (page as Page & { __mealimeAttempts?: string[] }).__mealimeAttempts ?? []
  19  |   ;(page as Page & { __mealimeAttempts?: string[] }).__mealimeAttempts = attempts
  20  |   await page.route('**/*', (route) => {
  21  |     const host = new URL(route.request().url()).hostname
  22  |     if (FORBIDDEN_HOSTS.test(host)) {
  23  |       attempts.push(route.request().url())
  24  |       return route.abort('blocked_by_client')
  25  |     }
  26  |     return route.continue()
  27  |   })
  28  | }
  29  | 
  30  | /** Assert that zero requests were made to mealime.com hosts. */
  31  | export async function expectZeroMealimeRequests(page: Page): Promise<void> {
  32  |   const attempts = (page as Page & { __mealimeAttempts?: string[] }).__mealimeAttempts ?? []
  33  |   expect(attempts, `requests to mealime.com hosts: ${attempts.join(', ')}`).toEqual([])
  34  | }
  35  | 
  36  | /**
  37  |  * Wait for the catalog to finish loading (recipe cards render).
  38  |  * Returns the list of recipe card articles.
  39  |  */
  40  | export function recipeCards(page: Page) {
  41  |   return page.locator('main article')
  42  | }
  43  | 
  44  | export async function waitForCatalog(page: Page): Promise<void> {
> 45  |   await expect(recipeCards(page).first()).toBeVisible({ timeout: 15_000 })
      |                                           ^ Error: expect(locator).toBeVisible() failed
  46  | }
  47  | 
  48  | /**
  49  |  * The code of the live room the header chip is showing.
  50  |  *
  51  |  * Read from the chip's `aria-label` (ADR-0049), which is now the ONLY
  52  |  * place the chip says anything: the chip itself is a dot, and the owner's
  53  |  * ruling took the word "Live" and the room code out of the header. The
  54  |  * label is the thing a screen reader announces and the thing the tooltip
  55  |  * bubble repeats, so a spec that scrapes it asserts the same sentence the
  56  |  * user is shown.
  57  |  */
  58  | export async function liveRoomCode(page: Page): Promise<string> {
  59  |   const chip = page.getByTestId('room-chip')
  60  |   await expect(chip).toHaveAttribute('aria-label', /^Live room /, { timeout: 15_000 })
  61  |   const label = await chip.getAttribute('aria-label')
  62  |   const code = label?.match(/Live room ([a-z0-9-]+)/i)?.[1]
  63  |   if (!code) throw new Error(`room chip carries no code: aria-label=${label}`)
  64  |   return code
  65  | }
  66  | 
  67  | /**
  68  |  * Pick a store-category override in the add form, the way a person does:
  69  |  * open the SHARED `FilterDropdown` (ADR-0050 §8 replaced the native
  70  |  * `<select>`, so `selectOption()` is gone) and click the option row.
  71  |  *
  72  |  * `value: ''` picks the "no override yet" placeholder.
  73  |  */
  74  | export async function pickCategoryOverride(page: Page, value: string): Promise<void> {
  75  |   await page.locator('[data-test=ingredient-category]').click()
  76  |   const menu = page.locator('[data-test=ingredient-category-menu]')
  77  |   await expect(menu).toBeVisible()
  78  |   const slug = value === '' ? 'none' : value
  79  |   await menu.locator(`[data-test="ingredient-category-option-${slug}"]`).click()
  80  |   await expect(menu).toHaveCount(0)
  81  | }
  82  | 
  83  | /**
  84  |  * Acknowledge the congrats modal that a shared `?room=` link raises
  85  |  * (ADR-0049), the way a person arriving on that link would.
  86  |  *
  87  |  * A no-op when the modal is not up, so a spec can call it after ANY link
  88  |  * open without first having to know whether this page came through a link
  89  |  * or through the household auto-join (ADR-0019, which must NOT open it).
  90  |  */
  91  | export async function dismissJoinCongrats(page: Page): Promise<void> {
  92  |   const modal = page.getByTestId('join-congrats')
  93  |   if ((await modal.count()) === 0) return
  94  |   await page.getByTestId('join-congrats-continue').click()
  95  |   await expect(modal).toHaveCount(0)
  96  | }
  97  | 
  98  | /**
  99  |  * The number the relay reports as live in this device's room, read off the
  100 |  * chip's `aria-label` (ADR-0049).
  101 |  *
  102 |  * The chip is a DOT, so the headcount has exactly one textual carrier —
  103 |  * `Live room <code>, <N> in room` — and that is what this reads. The
  104 |  * badge-dot (`room-chip-count`) is the same number rendered visually when
  105 |  * the count is 2 or more, but it is absent at 1, so it cannot be the
  106 |  * thing a helper waits on. Polled, because the count arrives on a `peers`
  107 |  * frame sent by a second socket.
  108 |  */
  109 | export async function liveRoomPeers(page: Page, timeout = 15_000): Promise<number> {
  110 |   const chip = page.getByTestId('room-chip')
  111 |   await expect(chip).toBeAttached({ timeout })
  112 |   await expect
  113 |     .poll(
  114 |       async () => {
  115 |         const label = (await chip.getAttribute('aria-label')) ?? ''
  116 |         const n = label.match(/, (\d+) in room/)?.[1]
  117 |         return n === undefined ? null : Number(n)
  118 |       },
  119 |       { timeout, message: 'the room chip never reported a headcount' },
  120 |     )
  121 |     .not.toBeNull()
  122 |   const label = (await chip.getAttribute('aria-label')) ?? ''
  123 |   return Number(label.match(/, (\d+) in room/)![1])
  124 | }
  125 | 
  126 | /** Open the first recipe card and wait for the detail sheet. Returns the recipe name. */
  127 | export async function openFirstRecipeDetail(page: Page): Promise<string> {
  128 |   await recipeCards(page).first().click()
  129 |   const sheet = page.getByRole('dialog')
  130 |   await expect(sheet).toBeVisible()
  131 |   return (await sheet.getByRole('heading', { level: 2 }).textContent())!.trim()
  132 | }
  133 | 
  134 | /** Open the first recipe card matching `name` and wait for the detail sheet. */
  135 | export async function openRecipeDetail(page: Page, name: string | RegExp): Promise<void> {
  136 |   await recipeCards(page).filter({ has: page.getByRole('heading', { name }) }).first().click()
  137 |   const sheet = page.getByRole('dialog')
  138 |   await expect(sheet).toBeVisible()
  139 |   return
  140 | }
  141 | 
  142 | export async function gotoTab(
  143 |   page: Page,
  144 |   label: 'Recipes' | 'Plan' | 'Grocery' | 'History' | 'Settings',
  145 | ): Promise<void> {
```