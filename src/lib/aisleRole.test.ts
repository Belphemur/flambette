import { describe, expect, test } from 'bun:test'
import { Beef, Croissant, Salad, Snowflake } from 'lucide-vue-next'
import { aisleIcon } from './aisleRole'
import { STORE_SECTIONS } from './sections'
import { ICON_ROLES } from './palette'

describe('aisleIcon', () => {
  test('EVERY store section carries a glyph (owner addendum)', () => {
    const missing = STORE_SECTIONS.filter((s) => aisleIcon(s) === null)
    expect(missing).toEqual([])
    for (const s of STORE_SECTIONS) {
      expect(typeof aisleIcon(s)!.glyph).toBe('function')
    }
  })

  test('EVERY store section carries a literal colour utility (ADR-0076)', () => {
    for (const s of STORE_SECTIONS) {
      const cls = aisleIcon(s)!.className
      // A literal, complete Tailwind utility — never interpolated, never
      // a `dark:` pair (the .dark block flips the variable).
      expect(cls.startsWith('text-'), `section ${s}`).toBe(true)
      expect(cls.split(' ')).toHaveLength(1)
      expect(cls).not.toContain('${')
      expect(cls).not.toContain('dark:')
    }
  })

  test('the two registry-claimed aisles reuse the FOOD registry tokens', () => {
    // An aisle band and a protein chip must never disagree about what
    // green or red means, so the aisle reuses the registry's own token.
    expect(aisleIcon('Produce')!.className).toBe(ICON_ROLES.vegetarian.className)
    expect(aisleIcon('Produce')!.glyph).toBe(Salad)
    expect(aisleIcon('Meat & Seafood')!.className).toBe(ICON_ROLES.meat.className)
    expect(aisleIcon('Meat & Seafood')!.glyph).toBe(Beef)
  })

  test('every other department wears the measured aisle family', () => {
    for (const s of STORE_SECTIONS) {
      if (s === 'Produce' || s === 'Meat & Seafood') continue
      expect(aisleIcon(s)!.className.startsWith('text-aisle-'), `section ${s}`).toBe(true)
    }
  })

  test('aliased departments are NEVER adjacent in STORE_SECTIONS order', () => {
    // Kindred departments deliberately share a token; two same-coloured
    // bands in a row would read as one broken aisle, so a shared class
    // must keep at least one section between them.
    for (let i = 0; i < STORE_SECTIONS.length - 1; i++) {
      expect(aisleIcon(STORE_SECTIONS[i])!.className).not.toBe(
        aisleIcon(STORE_SECTIONS[i + 1])!.className,
      )
    }
  })

  test('the department hue classes resolve to declared theme tokens', async () => {
    // A literal class is only as real as the token behind it: every
    // aisle class names a variable the style sheet defines.
    const style = await import('node:fs').then((fs) =>
      fs.promises.readFile(new URL('../../src/style.css', import.meta.url), 'utf8'),
    )
    for (const s of STORE_SECTIONS) {
      const token = aisleIcon(s)!.className.replace(/^text-/, '--color-')
      expect(style.includes(`${token}:`), `token ${token} for section ${s}`).toBe(true)
    }
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
