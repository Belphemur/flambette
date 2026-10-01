import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ICON_HUES, ICON_ROLES, hueClass, ingredientRole, proteinRole } from './palette'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const styleCss = readFileSync(resolve(REPO_ROOT, 'src/style.css'), 'utf8')
const designMd = readFileSync(resolve(REPO_ROOT, 'DESIGN.md'), 'utf8')

/** The colours DESIGN.md declares and `@theme` mirrors, token -> variable.
 *  `primary` is the only RENAMED pair (the CSS side is `--color-brand`, so
 *  the legacy `primary` utility does not shadow the theme token). */
const COLOR_TOKENS: Record<string, string> = {
  primary: '--color-brand',
  'primary-strong': '--color-brand-strong',
  'primary-soft': '--color-brand-soft',
  'primary-tint': '--color-brand-tint',
  'on-primary': '--color-on-brand',
  'hue-meat': '--color-hue-meat',
  'hue-meat-soft': '--color-hue-meat-soft',
  'hue-fish': '--color-hue-fish',
  'hue-fish-soft': '--color-hue-fish-soft',
  'hue-vegan': '--color-hue-vegan',
  'hue-vegan-soft': '--color-hue-vegan-soft',
  'nutrition-energy': '--color-nutrition-energy',
  'nutrition-energy-soft': '--color-nutrition-energy-soft',
  'nutrition-sodium': '--color-nutrition-sodium',
  'nutrition-sodium-soft': '--color-nutrition-sodium-soft',
  warning: '--color-warning',
  danger: '--color-danger',
  favourite: '--color-favourite',
  'favourite-soft': '--color-favourite-soft',
}

/** Non-colour tokens that must also stay in step. */
const DIMENSION_TOKENS: Record<string, string> = {
  'spacing.container': '--container-app',
  'spacing.reading': '--container-reading',
}

const FRONTMATTER = designMd.split('---')[1] ?? ''

function designColor(token: string): string | null {
  const m = FRONTMATTER.match(new RegExp(`^\\s{2}${token}:\\s*"([^"]+)"`, 'm'))
  return m ? m[1].toLowerCase() : null
}

function designDimension(token: string): string | null {
  const key = token.split('.')[1]
  const m = FRONTMATTER.match(new RegExp(`^\\s{2}${key}:\\s*"?([\\d.]+px)"?`, 'm'))
  return m ? m[1] : null
}

function themeVar(cssVar: string): string | null {
  const m = styleCss.match(new RegExp(`${cssVar}:\\s*([^;]+);`))
  return m ? m[1].trim().toLowerCase() : null
}

describe('icon hue contract (ADR-0035)', () => {
  test('each role owns a distinct token pair and a label', () => {
    const tokens = ICON_ROLES.map((r) => ICON_HUES[r].token)
    expect(new Set(tokens).size).toBe(tokens.length)
    for (const role of ICON_ROLES) {
      expect(ICON_HUES[role].darkToken).toBe(`${ICON_HUES[role].token}-soft`)
      expect(ICON_HUES[role].label.length).toBeGreaterThan(0)
    }
  })

  test('categorical roles are ingredient types, semantic roles are nutrition', () => {
    expect(ICON_HUES.meat.kind).toBe('categorical')
    expect(ICON_HUES.fish.kind).toBe('categorical')
    expect(ICON_HUES.vegan.kind).toBe('categorical')
    expect(ICON_HUES.energy.kind).toBe('semantic')
    expect(ICON_HUES.sodium.kind).toBe('semantic')
  })

  test('every mapped token VALUE matches between DESIGN.md and @theme', () => {
    // Name-only checks would let a colour drift silently: the whole point
    // of the mirror is that the CSS var carries the documented value.
    for (const [token, cssVar] of Object.entries(COLOR_TOKENS)) {
      const declared = designColor(token)
      expect(declared, `${token} missing from DESIGN.md`).not.toBeNull()
      expect(themeVar(cssVar), `${cssVar} missing from src/style.css`).not.toBeNull()
      expect(themeVar(cssVar)).toBe(declared)
    }
    for (const [token, cssVar] of Object.entries(DIMENSION_TOKENS)) {
      expect(designDimension(token), `${token} missing from DESIGN.md`).not.toBeNull()
      expect(themeVar(cssVar)).toBe(designDimension(token))
    }
  })

  test('hueClass spells its utilities out — no generated class names', () => {
    // Tailwind scans source TEXT for complete class names, so an
    // interpolated `text-${token}` emits no CSS and the icon ships
    // uncoloured (in dark mode only, which is why it slips through).
    for (const role of ICON_ROLES) {
      const cls = hueClass(role)
      expect(cls).not.toContain('${')
      expect(cls).toBe(`text-${ICON_HUES[role].token} dark:text-${ICON_HUES[role].darkToken}`)
      expect(cls.split(' ')).toHaveLength(2)
    }
  })
})

describe('ingredient type roles', () => {
  test('the three catalog categories map to their hue', () => {
    expect(ingredientRole('meat')).toBe('meat')
    expect(ingredientRole('fish')).toBe('fish')
    expect(ingredientRole('vegetarian')).toBe('vegan')
  })

  test('an unknown or absent category gets NO icon rather than a wrong hue', () => {
    // The catalog publishes exactly three category names; anything else is
    // a data change, and a wrong hue is worse than no icon.
    expect(ingredientRole('dessert')).toBeNull()
    expect(ingredientRole('')).toBeNull()
    expect(ingredientRole(null)).toBeNull()
    expect(ingredientRole(undefined)).toBeNull()
  })

  test('the protein filter reuses the same map, and "any" is no icon', () => {
    expect(proteinRole('meat')).toBe('meat')
    expect(proteinRole('vegetarian')).toBe('vegan')
    expect(proteinRole('')).toBeNull()
  })
})