import { describe, expect, test } from 'bun:test'
import { aisleRole } from './aisleRole'
import { STORE_SECTIONS } from './sections'
import { ICON_ROLES } from './palette'

describe('aisleRole', () => {
  test('the two aisles whose identity the registry already claims', () => {
    expect(aisleRole('Produce')).toBe('vegetarian')
    expect(aisleRole('Meat & Seafood')).toBe('meat')
  })

  test('every other department renders no glyph — never a borrowed hue', () => {
    const borrowed = STORE_SECTIONS.filter(
      (s) => aisleRole(s) !== null && s !== 'Produce' && s !== 'Meat & Seafood',
    )
    expect(borrowed).toEqual([])
  })

  test('the mapped roles are registry roles with a real glyph and hue', () => {
    for (const role of ['vegetarian', 'meat'] as const) {
      expect(ICON_ROLES[role]).toBeDefined()
      expect(ICON_ROLES[role].kind).toBe('categorical')
      expect(ICON_ROLES[role].className.startsWith('text-hue-')).toBe(true)
    }
  })

  test('an unknown section is an absence, not a fallback colour', () => {
    expect(aisleRole('Customer Service' as never)).toBeNull()
  })
})
