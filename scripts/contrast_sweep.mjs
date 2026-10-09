#!/usr/bin/env node
/**
 * Measured-WCAG sweep (slice 7): computed contrast of EVERY visible text
 * and keyline on EVERY surface, in BOTH themes, against the backgrounds
 * the browser actually resolved (tints composited, never token constants
 * — the design-visual spec's method, widened to all surfaces).
 *
 * NOT a CI suite — invoked manually after `bun run build`:
 *
 *   bun run build
 *   node scripts/contrast_sweep.mjs
 *
 * Gates: text 4.5:1 (normal) / 3.0:1 (>= 18.66px bold or >= 24px);
 * keylines (non-text) 3.0:1. Prints the worst pair per surface and exits
 * non-zero when a pair fails, so the sweep can be quoted in a report.
 *
 * ADR-0072 adds a dedicated section: the `success` completion fill.
 * A done-state box is NON-TEXT chrome under the 3:1 gate, and it has
 * two things to clear — the `on-success` tick it carries, and the paper
 * surface the box itself sits on. Both are measured from the computed
 * style of a REAL checked grocery row in both themes, never from token
 * constants, because the tint alpha is what the eye actually sees.
 */
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'

const BASE = 'http://localhost:4199'
const SURFACES = [
  { name: 'recipes', url: '/' },
  { name: 'plan', url: '/plan' },
  { name: 'grocery', url: '/grocery' },
  { name: 'history', url: '/history' },
  { name: 'settings', url: '/settings' },
  { name: 'cooking', url: null }, // reached through a recipe detail
  { name: 'shop', url: '/shop' },
]

async function openCooking(page) {
  await page.goto(`${BASE}/`)
  await page.locator('[data-test="recipe-card-link"]').first().waitFor({ timeout: 30_000 })
  await page.locator('[data-test="recipe-card-link"]').first().click()
  await page.getByRole('dialog').locator('[data-test="start-cooking"]').waitFor({ timeout: 15_000 })
  await page.getByRole('dialog').locator('[data-test="start-cooking"]').click()
  await page.waitForTimeout(700)
}

const MEASURE = () => {
  function lum(c) {
    const [r, g, b] = c.map((v) => {
      const s = v / 255
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  function ratio(a, b) {
    const [hi, lo] = [lum(a), lum(b)].sort((p, q) => q - p)
    return (hi + 0.05) / (lo + 0.05)
  }
  function parse(c) {
    const m = /rgba?\(([^)]+)\)/.exec(c)
    if (!m) return null
    const p = m[1].split(',').map((n) => parseFloat(n))
    const a = p.length > 3 ? p[3] : 1
    return { rgb: [p[0], p[1], p[2]], a }
  }
  // Composite an alpha background over what is behind it (tints, scrims).
  function over(fg, bg) {
    if (fg.a >= 0.999) return fg.rgb
    return fg.rgb.map((f, i) => f * fg.a + bg[i] * (1 - fg.a))
  }
  function hexToRgb(hex) {
    const m = /^#([0-9a-f]{6})$/i.exec(hex)
    if (!m) return null
    return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)]
  }
  function bgChain(el) {
    const layers = []
    let node = el
    while (node && node !== document.documentElement) {
      const c = parse(getComputedStyle(node).backgroundColor)
      if (c) layers.push(c)
      node = node.parentElement
    }
    const page = parse(getComputedStyle(document.body).backgroundColor)
    let acc = page ? page.rgb : [255, 255, 255]
    for (const layer of [...layers].reverse()) acc = over(layer, acc)
    return acc
  }
  const out = []
  const seen = new Set()
  for (const el of document.querySelectorAll('button, a, p, span, h1, h2, h3, label, input, strong, li, kbd, time')) {
    if (!(el instanceof HTMLElement)) continue
    const st = getComputedStyle(el)
    if (st.display === 'none' || st.visibility === 'hidden' || +st.opacity < 0.35) continue
    const rect = el.getBoundingClientRect()
    if (rect.width < 4 || rect.height < 4) continue
    const own = el.childNodes.length && Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim())
    const text = own ? el.textContent.trim().slice(0, 40) : null
    if (text) {
      const key = `T|${text}`
      if (!seen.has(key)) {
        seen.add(key)
        const fg = parse(st.color)
        if (fg) {
          const px = parseFloat(st.fontSize)
          const bold = parseInt(st.fontWeight) >= 700
          const large = px >= 24 || (px >= 18.66 && bold)
          out.push({
            kind: 'text',
            large,
            label: text,
            ratio: Number(ratio(over(fg, bgChain(el)), bgChain(el)).toFixed(2)),
          })
        }
      }
    }
    // Keyline: the CONTROL keyline only (border-strong — ADR-0067 names it
    // "control keyline", gate 3:1). Chip/card tint borders are ADR-0069
    // decoration whose state is carried by fill+text, not the keyline.
    const strongVar = getComputedStyle(document.documentElement).getPropertyValue('--color-border-strong').trim()
    const strongRgb = hexToRgb(strongVar)
    const bw = parseFloat(st.borderTopWidth) + parseFloat(st.borderLeftWidth)
    const bc = parse(st.borderTopColor)
    const borderIsControl =
      bc && strongRgb && bc.a > 0.5 && bc.rgb.every((v, i) => Math.abs(v - strongRgb[i]) <= 2)
    if (bw > 0 && bc && el.tagName === 'BUTTON' && borderIsControl) {
      const key = `K|${text ?? el.tagName}`
      if (!seen.has(key)) {
        seen.add(key)
        out.push({ kind: 'keyline', large: false, label: text ?? el.tagName, ratio: Number(ratio(over(bc, bgChain(el)), bgChain(el)).toFixed(2)) })
      }
    }
  }
  return out
}


const preview = spawn('bun', ['run', 'preview', '--port', '4199', '--strictPort'], { stdio: 'ignore' })
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('preview server did not start')), 30_000)
  const probe = setInterval(async () => {
    try {
      await fetch(BASE)
      clearTimeout(t)
      clearInterval(probe)
      resolve()
    } catch {}
  }, 300)
})

let exitCode = 0
try {
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await ctx.newPage()
  await page.route('**/*', (route) =>
    route.request().url().startsWith('http://localhost') ? route.continue() : route.abort(),
  )
  await page.goto(`${BASE}/`)
  await page.locator('[data-test="recipe-card-link"]').first().waitFor({ timeout: 30_000 })

  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') await page.getByRole('button', { name: 'Switch to dark mode' }).click()
    for (const surface of SURFACES) {
      if (surface.url) {
        await page.goto(`${BASE}${surface.url}`)
        await page.waitForTimeout(700)
      } else {
        await openCooking(page)
      }
      const samples = await page.evaluate(MEASURE)
      const fails = samples.filter((s) => s.ratio < (s.kind === 'text' ? (s.large ? 3.0 : 4.5) : 3.0))
      const textOnly = samples.filter((s) => s.kind === 'text').sort((a, b) => a.ratio - b.ratio)
      const keyOnly = samples.filter((s) => s.kind === 'keyline').sort((a, b) => a.ratio - b.ratio)
      console.log(`\n== ${theme} / ${surface.name}: ${samples.length} samples, ${fails.length} FAIL`)
      console.log(`   worst text: ${textOnly[0] ? `${textOnly[0].ratio} "${textOnly[0].label}"` : 'n/a'}`)
      console.log(`   worst keyline: ${keyOnly[0] ? `${keyOnly[0].ratio} "${keyOnly[0].label}"` : 'n/a'}`)
      for (const f of fails) {
        exitCode = 1
        console.log(`   FAIL ${f.kind}${f.large ? '(large)' : ''} ${f.ratio}: "${f.label}"`)
      }
      if (surface.url === null) await page.getByRole('button', { name: 'Close cooking mode' }).click().catch(() => {})
      if (surface.name === 'shop') await page.goBack() // fullscreen has no header for the next toggle
    }
  }
  /* ---------- ADR-0072: the success completion fill ---------- */
  // Seed ONE real plan first: the app is the only seeder allowed (a fixture
  // would measure a page nobody can reach), so the first catalog recipe is
  // planned through its own detail sheet exactly as the board capture does.
  await page.goto(`${BASE}/`)
  await page.locator('[data-test="recipe-card-link"]').first().waitFor({ timeout: 30_000 })
  await page.locator('[data-test="recipe-card-link"]').first().click()
  const sheet = page.getByRole('dialog')
  await sheet.getByRole('button', { name: 'Add to plan' }).click()
  await sheet.getByRole('button', { name: 'Back' }).click().catch(() => {})
  for (const theme of ['light', 'dark']) {
    // The previous loop leaves the app in whichever theme it ended on, so the
    // toggle is only pressed when the app is NOT already in the target theme.
    const isDark = async () =>
      (await page.evaluate(() => document.documentElement.classList.contains('dark'))) === true
    if ((theme === 'dark') !== (await isDark())) {
      await page.getByRole('button', { name: /Switch to (dark|light) mode/ }).click()
      await page.waitForTimeout(300)
    }
    await page.goto(`${BASE}/grocery`)
    await page.locator('[data-test="grocery-row"] input[type=checkbox]').first().waitFor({ timeout: 20_000 })
    await page.locator('[data-test="grocery-row"] input[type=checkbox]').first().check()
    await page.waitForTimeout(300)
/** The `success` fill's own pairs, measured off a REAL checked row. */
function MEASURE_SUCCESS() {
  function hexToRgb(hex) {
    const h = hex.replace('#', '').trim()
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16))
  }
  function lum(c) {
    const [r, g, b] = c.map((v) => {
      const s = v / 255
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  function ratio(a, b) {
    const [hi, lo] = [lum(a), lum(b)].sort((p, q) => q - p)
    return (hi + 0.05) / (lo + 0.05)
  }
  function parse(c) {
    const m = /rgba?\(([^)]+)\)/.exec(c)
    if (!m) return null
    const p = m[1].split(',').map((n) => parseFloat(n))
    const a = p.length > 3 ? p[3] : 1
    return { rgb: [p[0], p[1], p[2]], a }
  }
  // Composite an alpha background over what is behind it.
  function over(fg, bg) {
    if (!fg || fg.a >= 1) return fg.rgb
    return fg.rgb.map((v, i) => v * fg.a + bg[i] * (1 - fg.a))
  }
  function bgChain(el) {
    let cur = el
    let acc = [255, 255, 255]
    const chain = []
    while (cur) {
      const c = parse(getComputedStyle(cur).backgroundColor)
      if (c && c.a > 0) chain.push(c)
      cur = cur.parentElement
    }
    for (let i = chain.length - 1; i >= 0; i--) acc = over(chain[i], acc)
    return acc
  }
  const box = document.querySelector('[data-test="grocery-row"] input[type=checkbox]')
  if (!box) return []
  const st = getComputedStyle(box)
  const rowBg = bgChain(box.closest('[data-test="grocery-row"]') ?? box)
  const fill = parse(st.accentColor) ?? parse(st.backgroundColor)
  const out = []
  if (fill) {
    // The fill against the surface the box sits on (non-text, 3:1).
    out.push({
      kind: 'keyline',
      large: false,
      label: 'success fill vs the grocery surface',
      ratio: Number(ratio(over(fill, rowBg), rowBg).toFixed(2)),
    })
    // The tick: `on-success` is the CSS variable the platform draws, so
    // read it from the document root rather than guessing.
    const onSuccess = getComputedStyle(document.documentElement).getPropertyValue('--color-on-success').trim()
    const tick = hexToRgb(onSuccess)
    out.push({
      kind: 'text',
      large: false,
      label: 'on-success tick on the success fill',
      ratio: Number(ratio(over({ rgb: tick, a: 1 }, over(fill, rowBg)), over(fill, rowBg)).toFixed(2)),
    })
  }
  return out
}

    const pairs = await page.evaluate(MEASURE_SUCCESS)
    console.log(`\n== ${theme} / success fill (ADR-0072)`)
    for (const p of pairs) {
      const gate = p.kind === 'text' ? (p.large ? 3.0 : 4.5) : 3.0
      const ok = p.ratio >= gate
      if (!ok) exitCode = 1
      console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${p.kind} ${p.ratio} (gate ${gate}): ${p.label}`)
    }
  }
  await browser.close()
} finally {
  preview.kill('SIGTERM')
}
process.exit(exitCode)

await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('preview server did not start')), 30_000)
  const probe = setInterval(async () => {
    try {
      await fetch(BASE)
      clearTimeout(t)
      clearInterval(probe)
      resolve()
    } catch {}
  }, 300)
})

try {
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await ctx.newPage()
  await page.route('**/*', (route) =>
    route.request().url().startsWith('http://localhost') ? route.continue() : route.abort(),
  )
  await page.goto(`${BASE}/`)
  await page.locator('[data-test="recipe-card-link"]').first().waitFor({ timeout: 30_000 })

  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') await page.getByRole('button', { name: 'Switch to dark mode' }).click()
    for (const surface of SURFACES) {
      if (surface.url) {
        await page.goto(`${BASE}${surface.url}`)
        await page.waitForTimeout(700)
      } else {
        await openCooking(page)
      }
      const samples = await page.evaluate(MEASURE)
      const fails = samples.filter((s) => s.ratio < (s.kind === 'text' ? (s.large ? 3.0 : 4.5) : 3.0))
      const textOnly = samples.filter((s) => s.kind === 'text').sort((a, b) => a.ratio - b.ratio)
      const keyOnly = samples.filter((s) => s.kind === 'keyline').sort((a, b) => a.ratio - b.ratio)
      console.log(`\n== ${theme} / ${surface.name}: ${samples.length} samples, ${fails.length} FAIL`)
      console.log(`   worst text: ${textOnly[0] ? `${textOnly[0].ratio} "${textOnly[0].label}"` : 'n/a'}`)
      console.log(`   worst keyline: ${keyOnly[0] ? `${keyOnly[0].ratio} "${keyOnly[0].label}"` : 'n/a'}`)
      for (const f of fails) {
        exitCode = 1
        console.log(`   FAIL ${f.kind}${f.large ? '(large)' : ''} ${f.ratio}: "${f.label}"`)
      }
      if (surface.url === null) await page.getByRole('button', { name: 'Close cooking mode' }).click().catch(() => {})
      if (surface.name === 'shop') await page.goBack() // fullscreen has no header for the next toggle
    }
  }
  /* ---------- ADR-0072: the success completion fill ---------- */
  // Seed ONE real plan first: the app is the only seeder allowed (a fixture
  // would measure a page nobody can reach), so the first catalog recipe is
  // planned through its own detail sheet exactly as the board capture does.
  await page.goto(`${BASE}/`)
  await page.locator('[data-test="recipe-card-link"]').first().waitFor({ timeout: 30_000 })
  await page.locator('[data-test="recipe-card-link"]').first().click()
  const sheet = page.getByRole('dialog')
  await sheet.getByRole('button', { name: 'Add to plan' }).click()
  await sheet.getByRole('button', { name: 'Back' }).click().catch(() => {})
  for (const theme of ['light', 'dark']) {
    // The previous loop leaves the app in whichever theme it ended on, so the
    // toggle is only pressed when the app is NOT already in the target theme.
    const isDark = async () =>
      (await page.evaluate(() => document.documentElement.classList.contains('dark'))) === true
    if ((theme === 'dark') !== (await isDark())) {
      await page.getByRole('button', { name: /Switch to (dark|light) mode/ }).click()
      await page.waitForTimeout(300)
    }
    await page.goto(`${BASE}/grocery`)
    await page.locator('[data-test="grocery-row"] input[type=checkbox]').first().waitFor({ timeout: 20_000 })
    await page.locator('[data-test="grocery-row"] input[type=checkbox]').first().check()
    await page.waitForTimeout(300)
    const pairs = await page.evaluate(MEASURE_SUCCESS)
    console.log(`\n== ${theme} / success fill (ADR-0072)`)
    for (const p of pairs) {
      const gate = p.kind === 'text' ? (p.large ? 3.0 : 4.5) : 3.0
      const ok = p.ratio >= gate
      if (!ok) exitCode = 1
      console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${p.kind} ${p.ratio} (gate ${gate}): ${p.label}`)
    }
  }
  await browser.close()
} finally {
  preview.kill('SIGTERM')
}
process.exit(exitCode)

