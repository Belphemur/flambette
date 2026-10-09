import { describe, expect, test } from 'bun:test'
import { Croissant, Snowflake } from 'lucide-vue-next'
import { aisleIcon, aisleRole } from './aisleRole'
import { STORE_SECTIONS } from './sections'
import { ICON_ROLES, roleGlyph } from './palette'

describe('aisleIcon', () => {
  test('EVERY store section carries a glyph (owner addendum)', () => {
    const missing = STORE_SECTIONS.filter((s) => aisleIcon(s) === null)
    expect(missing).toEqual([])
    for (const s of STORE_SECTIONS) {
      expect(typeof aisleIcon(s)!.glyph).toBe('function')
    }
  })

  test('the two aisles whose identity the registry claims wear its hue', () => {
    expect(aisleIcon('Produce')!.role).toBe('vegetarian')
    expect(aisleIcon('Meat & Seafood')!.role).toBe('meat')
  })

  test('exactly two — a department never borrows another question\u2019s colour', () => {
    const hued = STORE_SECTIONS.filter((s) => aisleIcon(s)!.role !== null)
    expect(hued).toEqual(['Produce', 'Meat & Seafood'])
  })

  test('the glyph is the department\u2019s own shape even when a hue is worn', () => {
    // The role's glyph and the table's glyph agree, so a call site that
    // renders `.glyph` alone is correct — only the colour differs.
    expect(aisleIcon('Produce')!.glyph).toBe(roleGlyph('vegetarian'))
    expect(aisleIcon('Meat & Seafood')!.glyph).toBe(roleGlyph('meat'))
  })

  test('glyphs are distinct across departments — a scan reads each aisle apart', () => {
    const glyphs = STORE_SECTIONS.map((s) => aisleIcon(s)!.glyph)
    expect(new Set(glyphs).size).toBe(STORE_SECTIONS.length)
  })

  test('a known shape is bound to its section (no transposed table rows)', () => {
    expect(aisleIcon('Bakery')!.glyph).toBe(Croissant)
    expect(aisleIcon('Frozen')!.glyph).toBe(Snowflake)
    expect(aisleIcon('Bakery')!.glyph).not.toBe(aisleIcon('Frozen')!.glyph)
  })

  test('an unknown name is an absence, not a fallback icon', () => {
    // 'Uncategorized' is the extras view's bucket label, not a department.
    expect(aisleIcon('Uncategorized')).toBeNull()
  })
})

describe('aisleRole (hue-only read)', () => {
  test('the mapped roles are registry roles with a real glyph and hue', () => {
    for (const role of ['vegetarian', 'meat'] as const) {
      expect(ICON_ROLES[role]).toBeDefined()
      expect(ICON_ROLES[role].kind).toBe('categorical')
      expect(ICON_ROLES[role].className.startsWith('text-hue-')).toBe(true)
    }
  })

  test('every other department renders no hue', () => {
    const borrowed = STORE_SECTIONS.filter(
      (s) => aisleRole(s) !== null && s !== 'Produce' && s !== 'Meat & Seafood',
    )
    expect(borrowed).toEqual([])
  })
})
