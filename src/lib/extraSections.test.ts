import { describe, expect, test } from 'bun:test'
import {
  UNCATEGORIZED,
  extraCollapseKey,
  groupExtras,
  isKnownExtraCategory,
  storeCollapseKey,
} from './extraSections'

describe('groupExtras (ADR-0050)', () => {
  test('no extras yields no sub-sections', () => {
    expect(groupExtras([])).toEqual([])
  })

  test('every extra is kept, in input order inside its group', () => {
    const groups = groupExtras([
      { name: 'milk', category: 'Dairy, Cheese & Eggs' },
      { name: 'bread', category: 'Bakery' },
      { name: 'butter', category: 'Dairy, Cheese & Eggs' },
    ])
    expect(groups.map((g) => g.name)).toEqual(['Bakery', 'Dairy, Cheese & Eggs'])
    expect(groups.find((g) => g.name === 'Dairy, Cheese & Eggs')!.items).toEqual([
      { name: 'milk', category: 'Dairy, Cheese & Eggs' },
      { name: 'butter', category: 'Dairy, Cheese & Eggs' },
    ])
  })

  test('sub-section order follows STORE_SECTIONS, not insertion order', () => {
    const groups = groupExtras([
      { name: 'tent', category: 'Household' },
      { name: 'banana', category: 'Produce' },
      { name: 'frozen peas', category: 'Frozen' },
    ])
    expect(groups.map((g) => g.name)).toEqual(['Produce', 'Frozen', 'Household'])
  })

  test('empty categories never render, even though STORE_SECTIONS has them', () => {
    const groups = groupExtras([{ name: 'banana', category: 'Produce' }])
    expect(groups.map((g) => g.name)).toEqual(['Produce'])
  })

  test('missing, empty and "Other" categories land in Uncategorized, positioned LAST', () => {
    const groups = groupExtras([
      { name: 'mystery one' },
      { name: 'mystery two', category: '' },
      { name: 'mystery three', category: 'Other' },
      { name: 'banana', category: 'Produce' },
    ])
    expect(groups.map((g) => g.name)).toEqual(['Produce', UNCATEGORIZED])
    const last = groups[groups.length - 1]
    expect(last.items).toHaveLength(3)
    expect(last.items.map((i) => i.name)).toEqual(['mystery one', 'mystery two', 'mystery three'])
  })

  test('Uncategorized is not rendered when every extra has a category', () => {
    const groups = groupExtras([{ name: 'banana', category: 'Produce' }])
    expect(groups.map((g) => g.name)).not.toContain(UNCATEGORIZED)
  })

  test('a category outside STORE_SECTIONS is not routed — it is Uncategorized', () => {
    const groups = groupExtras([{ name: 'thing', category: 'Made Up Section' }])
    expect(groups).toEqual([
      { name: UNCATEGORIZED, items: [{ name: 'thing', category: 'Made Up Section' }] },
    ])
  })

  test('"Other" is a known STORE_SECTION but still the Uncategorized bucket', () => {
    expect(isKnownExtraCategory('Other')).toBe(true)
    expect(isKnownExtraCategory('Produce')).toBe(true)
    expect(isKnownExtraCategory('Nope')).toBe(false)
    expect(groupExtras([{ name: 'x', category: 'Other' }])[0].name).toBe(UNCATEGORIZED)
  })

  test('the same item name is never dropped', () => {
    const extras = [
      { name: 'banana', category: 'Produce' },
      { name: 'banana', category: 'Produce' },
      { name: 'napkins', category: 'Household' },
    ]
    const groups = groupExtras(extras)
    expect(groups.flatMap((g) => g.items).map((i) => i.name)).toEqual(['banana', 'banana', 'napkins'])
  })
})

describe('collapse keys (ADR-0050 §5 — the extras/store name collision)', () => {
  test('an extras key never equals a store key for the same name', () => {
    for (const name of ['Produce', 'Household', 'Dairy, Cheese & Eggs']) {
      expect(extraCollapseKey(name)).not.toBe(storeCollapseKey(name))
      expect(extraCollapseKey(name)).not.toBe(name)
      expect(storeCollapseKey(name)).not.toBe(name)
    }
  })

  test('keys are injective: distinct names never collide, spaces and all', () => {
    const names = ['Produce', 'Household', 'Uncategorized', 'Dairy, Cheese & Eggs', 'Other']
    const extras = new Set(names.map(extraCollapseKey))
    const stores = new Set(names.map(storeCollapseKey))
    expect(extras.size).toBe(names.length)
    expect(stores.size).toBe(names.length)
    for (const k of extras) expect(stores.has(k)).toBe(false)
  })
})