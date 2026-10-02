import { describe, expect, test } from 'bun:test'
import {
  matchLineItems,
  measuredChipsForLines,
  measuredQuantity,
  mentionsIngredient,
} from './measuredAmounts'
import type { LineItem, RecipeDoc } from './types'

const item = (quantity: string, ingredient_name: string): LineItem => ({
  id: 0,
  quantity,
  ingredient_name,
})

const doc = (line_items: LineItem[], serving_count = 6): RecipeDoc =>
  ({ id: 1, line_items, serving_count } as unknown as RecipeDoc)

describe('mentionsIngredient', () => {
  test('word-boundary matching through the grocery nameKey', () => {
    expect(mentionsIngredient('juice of ¾ lemon', 'lemons')).toBe(true)
    expect(mentionsIngredient('extra virgin olive oil', 'olive oil')).toBe(true)
    // The FULL name must appear — a bare head noun is the head-noun path.
    expect(mentionsIngredient('zest of a potato', 'russet potatoes')).toBe(false)
    expect(mentionsIngredient('zest of a potato', 'potatoes')).toBe(true)
    // Not a word-boundary hit — never attribute a number to these.
    expect(mentionsIngredient('juice of ¾ lime', 'lemons')).toBe(false)
    expect(mentionsIngredient('1 lb chicken', 'chick')).toBe(false)
  })

  test('plurals match in BOTH directions (qodo 4128519653)', () => {
    // Ingredient singular, step line plural — the reported case.
    expect(mentionsIngredient('juice of 2 lemons', 'lemon')).toBe(true)
    // And the reverse: ingredient plural, line singular.
    expect(mentionsIngredient('juice of ¾ lemon', 'lemon')).toBe(true)
    // o-es / s-es plurals keep their boundaries.
    expect(mentionsIngredient('2 tomatoes', 'tomato')).toBe(true)
    expect(mentionsIngredient('2 potatoes', 'potato')).toBe(true)
    // No widening past the boundary: "chick" never matches "chicken".
    expect(mentionsIngredient('1 lb chickens', 'chick')).toBe(false)
  })
})

describe('matchLineItems', () => {
  const items = [
    item('1 large (210 g)', 'russet potato'),
    item('3', 'lemons'),
    item('½ (142 g) pkg', 'baby spinach'),
  ]

  test('full-name match wins', () => {
    expect(matchLineItems('juice of ¾ lemon', items).map((i) => i.ingredient_name)).toEqual(['lemons'])
  })

  test('a head noun is only used when unambiguous', () => {
    // "a potato" is only in the list as "russet potato".
    expect(matchLineItems('add a potato', items).map((i) => i.ingredient_name)).toEqual([
      'russet potato',
    ])
    // Two spinach-ish items exist → say nothing rather than guess.
    expect(
      matchLineItems('a handful of spinach', [
        item('½ (142 g) pkg', 'baby spinach'),
        item('2', 'frozen spinach'),
      ]),
    ).toEqual([])
  })

  test('items without a measured quantity are never matched', () => {
    expect(matchLineItems('a splash of olive oil', [item('  ', 'olive oil')])).toEqual([])
  })
})

describe('measuredQuantity', () => {
  test('authored text is kept verbatim at the authored servings', () => {
    expect(measuredQuantity(item('1 large (210 g)', 'russet potato'), 1, 6)).toBe('1 large (210 g)')
    expect(measuredQuantity(item('½ (142 g) pkg', 'baby spinach'), 1, 6)).toBe('½ (142 g) pkg')
  })

  test('container units ceil-merge like the grocery list (ADR-0017)', () => {
    // ½ pkg at 2× is one whole package, not one.
    expect(measuredQuantity(item('½ (142 g) pkg', 'baby spinach'), 2, 6)).toBe('1 (142 g) pkg')
    expect(measuredQuantity(item('1 small bunch', 'cilantro'), 3, 6)).toBe('3 small bunches')
  })

  test('ordinary units scale linearly, seasonings sub-linearly (ADR-0009)', () => {
    expect(measuredQuantity(item('3', 'lemons'), 2, 6)).toBe('6')
    expect(measuredQuantity(item('1 ½', 'lemons'), 2, 6)).toBe('3')
    // Seasonings are capped at 2× (ADR-0009), so 1 tsp at 4× is 2 tsp.
    expect(measuredQuantity(item('1 tsp', 'salt'), 4, 6)).toBe('2 tsp')
  })
})

describe('measuredChipsForLines', () => {
  const d = doc([
    item('3', 'lemons'),
    item('1 ½ (227 g) block', 'cheddar cheese'),
    item('2', 'cloves garlic'),
    item('710 ml', 'milk'),
  ])

  test('imprecise lines get a chip in step order', () => {
    const chips = measuredChipsForLines(d, ['6 cloves garlic', 'juice of ¾ lemon'], 1)
    expect(chips).toEqual([{ lineIndex: 1, label: 'measured: 3 lemons' }])
  })

  test('a plural step line still yields a chip (qodo 4128519653)', () => {
    // "juice of 2 lemons" is imprecise (the 2 is not the line item count)
    // and must pick up the "3 lemons" line item.
    expect(measuredChipsForLines(d, ['juice of 2 lemons'], 1)).toEqual([
      { lineIndex: 0, label: 'measured: 3 lemons' },
    ])
  })

  test('lines that already carry a parseable amount get no chip', () => {
    expect(measuredChipsForLines(d, ['2 cloves garlic', '710 ml milk', '¾ (227 g) block cheddar cheese'], 1)).toEqual([])
  })

  test('two imprecise ingredients on one line yield two chips', () => {
    const chips = measuredChipsForLines(d, ['juice of ¾ lemon and a splash of milk'], 1)
    expect(chips.map((c) => c.label)).toEqual(['measured: 3 lemons', 'measured: 710 ml milk'])
  })

  test('scaling applies to the chip, not the authored line', () => {
    expect(measuredChipsForLines(d, ['juice of ¾ lemon'], 2)).toEqual([
      { lineIndex: 0, label: 'measured: 6 lemons' },
    ])
  })

  test('no line items → no chips, and nothing is invented', () => {
    expect(measuredChipsForLines(doc([]), ['a potato'], 1)).toEqual([])
    expect(measuredChipsForLines(d, ['a potato'], 1)).toEqual([])
  })

  /* ---------- ADR-0047: the chip localizes, the doc does not ---------- */

  test('imperial localizes the chip quantity; metric leaves it canonical', () => {
    // 710 ml → 24.0 fl oz, a bare unit (no container annotation).
    expect(measuredChipsForLines(d, ['a splash of milk'], 1, 'imperial')).toEqual([
      { lineIndex: 0, label: 'measured: 24 fl oz milk' },
    ])
    // The default argument is metric = today's text, unchanged.
    expect(measuredChipsForLines(d, ['a splash of milk'], 1)).toEqual([
      { lineIndex: 0, label: 'measured: 710 ml milk' },
    ])
  })

  test('a count chip (lemons) is untouched by the unit system', () => {
    expect(measuredChipsForLines(d, ['juice of ¾ lemon'], 1, 'imperial')).toEqual([
      { lineIndex: 0, label: 'measured: 3 lemons' },
    ])
  })

  test('a container chip localizes its ANNOTATION and keeps the count', () => {
    const cheese = doc([item('1 ½ (227 g) block', 'cheddar cheese')])
    expect(measuredChipsForLines(cheese, ['a slab of cheddar cheese'], 1, 'imperial')).toEqual([
      { lineIndex: 0, label: 'measured: 1.5 (8 oz) block cheddar cheese' },
    ])
  })
})
