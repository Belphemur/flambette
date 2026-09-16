/* Capture app screenshots for the README against the local container. */
const { chromium } = require('playwright')

const BASE = process.env.APP_URL || 'http://localhost:8097'
const OUT = '/home/balor/workspace/mealime-app/docs/screenshots'

async function main() {
  // First three variant ids from the catalog for seeding a plan.
  const catalog = await fetch(`${BASE}/data/builder_data.json`).then((r) => r.json())
  const ids = catalog.feasible_variants.slice(0, 3)
  const seed = {
    plan: ids.map((variantId) => ({ variantId, servings: 2 })),
    customItems: ['Baguette', 'Sparkling water'],
  }

  const browser = await chromium.launch()
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
  })
  const page = await ctx.newPage()
  await page.addInitScript((s) => {
    localStorage.setItem('mealime-planner:v1:plan', JSON.stringify(s))
  }, seed)

  // 1. Recipes grid (light)
  await page.goto(BASE)
  await page.locator('main article').first().waitFor({ timeout: 20000 })
  await page.waitForTimeout(800)
  await page.screenshot({ path: `${OUT}/recipes.png` })

  // 2. Recipe detail
  await page.locator('main article').first().click()
  await page.getByRole('dialog').waitFor({ timeout: 10000 })
  await page.waitForTimeout(1200)
  await page.screenshot({ path: `${OUT}/recipe-detail.png` })
  await page.getByRole('button', { name: 'Back', exact: true }).click()

  // 3. Plan tab
  await page.getByRole('navigation').getByRole('button', { name: 'Plan' }).click()
  await page.waitForTimeout(800)
  await page.screenshot({ path: `${OUT}/plan.png` })

  // 4. Grocery tab (aggregated + custom items)
  await page.getByRole('navigation').getByRole('button', { name: 'Grocery' }).click()
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${OUT}/grocery.png` })

  // 5. Cooking mode (first planned recipe)
  await page.goto(`${BASE}/cooking/${ids[0]}`)
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${OUT}/cooking.png` })

  // 6. Recipes in dark mode
  await page.goto(BASE)
  await page.getByRole('button', { name: /dark mode|light mode/ }).click()
  await page.waitForTimeout(800)
  await page.screenshot({ path: `${OUT}/dark-mode.png` })

  await browser.close()
  console.log('done')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
