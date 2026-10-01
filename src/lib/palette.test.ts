import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ICON_HUES, ICON_ROLES, hueClass, ingredientRole, proteinRole } from './palette'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const styleCss = readFileSync(resolve(REPO_ROOT, 'src/style.css'), 'utf8')
const designMd = readFileSync(resolve(REPO_ROOT, 'DESIGN.md'), 'utf8')

describe('icon hue contract (ADR-0035)', () => {
  test('every role owns a distinct token pair and a label', () => {
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

  test('every token is mirrored into the @theme block of src/style.css', () => {
    // DESIGN.md -> style.css is a hand-maintained transcription; a token
    // added to one and not the other silently loses its colour.
    for (const role of ICON_ROLES) {
      const { token, darkToken } = ICON_HUES[role]
      expect(styleCss).toContain(`--color-${token}:`)
      expect(styleCss).toContain(`--color-${darkToken}:`)
    }
  })

  test('every token is declared in the DESIGN.md front-matter', () => {
    for (const role of ICON_ROLES) {
      const { token, darkToken } = ICON_HUES[role]
      expect(designMd).toMatch(new RegExp(`^\\s{2}${token}: "#`, 'm'))
      expect(designMd).toMatch(new RegExp(`^\\s{2}${darkToken}: "#`, 'm'))
    }
  })

  test('hueClass derives both the light and the dark utility from the token', () => {
    expect(hueClass('meat')).toBe('text-hue-meat dark:text-hue-meat-soft')
    expect(hueClass('sodium')).toBe('text-nutrition-sodium dark:text-nutrition-sodium-soft')
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