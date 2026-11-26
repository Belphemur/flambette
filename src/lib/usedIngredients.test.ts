import { describe, expect, test } from 'bun:test'
import { measuredChipsForLines } from './measuredAmounts'
import { restrictedDocView, type LadderIndex } from './restrictions'
import type { LineItem, RecipeDoc } from './types'
import { usedIngredientKey } from './usedIngredients'

const item = (quantity: string, ingredient_name: string): LineItem => ({
  id: 0,
  quantity,
  ingredient_name,
})

const doc = (line_items: LineItem[], serving_count = 6): RecipeDoc =>
  ({ id: 1, line_items, serving_count } as unknown as RecipeDoc)

describe('usedIngredientKey (ADR-0103)', () => {
  const recipe = doc([item('3', 'lemons'), item('1 ½ (227 g) block', 'cheddar cheese')])

  test('the ONE shape is stepIndex:lineIndex:ingredient-nameKey', () => {
    const chip = measuredChipsForLines(recipe, ['juice of ¾ lemon'], 1)[0]
    expect(chip).toBeDefined()
    expect(usedIngredientKey(2, chip)).toBe('2:0:lemon')
  })

  test('the rendered quantity never enters the key (live servings scaling)', () => {
    const atSix = measuredChipsForLines(recipe, ['juice of ¾ lemon'], 1, 'metric')[0]
    const atTwelve = measuredChipsForLines(recipe, ['juice of ¾ lemon'], 2, 'imperial')[0]
    expect(atSix.quantity).not.toBe(atTwelve.quantity)
    expect(usedIngredientKey(3, atSix)).toBe(usedIngredientKey(3, atTwelve))
  })

  test('step and detail-line indices keep distinct claims apart', () => {
    const chip = measuredChipsForLines(recipe, ['juice of ¾ lemon'], 1)[0]
    expect(usedIngredientKey(3, chip)).not.toBe(usedIngredientKey(4, chip))

    const lines = measuredChipsForLines(recipe, ['juice of ¾ lemon', 'zest of a lemon'], 1)
    expect(lines).toHaveLength(2)
    expect(usedIngredientKey(1, lines[0])).not.toBe(usedIngredientKey(1, lines[1]))
  })

  test('plural spellings of the same ingredient share one key', () => {
    const singular = measuredChipsForLines(doc([item('3', 'lemon')]), ['juice of ¾ lemon'], 1)[0]
    const plural = measuredChipsForLines(doc([item('3', 'lemons')]), ['juice of ¾ lemon'], 1)[0]
    expect(usedIngredientKey(0, singular)).toBe(usedIngredientKey(0, plural))
  })

  test('a restriction swap changes the DISPLAY name but never the key', () => {
    const base = doc([item('3', 'lemon juice')])
    const index: LadderIndex = {
      restrictions: [],
      swaps: [{ from: 'lemon juice', to: 'lemon', quantityRule: 'global', count: 1 }],
      drops: {},
      removed: new Map(),
      pairs: new Map(),
      events: new Map(),
    }
    const restricted = restrictedDocView(base, index, [1])
    const lines = ['add lemon juice to taste']
    const baseChip = measuredChipsForLines(base, lines, 1)[0]
    const viewChip = measuredChipsForLines(restricted, lines, 1, 'dual', base)[0]

    expect(baseChip).toBeDefined()
    expect(viewChip).toBeDefined()
    // The card shows the substituted name, but the tick follows the BASE
    // line item identity: toggling a restriction cannot orphan a tick.
    expect(viewChip.ingredient).toBe('lemon')
    expect(viewChip.keyIngredient).toBe('lemon juice')
    expect(usedIngredientKey(5, viewChip)).toBe(usedIngredientKey(5, baseChip))
  })
})
