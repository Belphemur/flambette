import { describe, expect, test } from 'bun:test'
import { aggregateGroceries, type AggregateInput } from './grocery'
import type { LineItem, RecipeDoc } from './types'

function doc(name: string, servingCount: number, lines: [string, string][]): RecipeDoc {
  return {
    id: 1,
    recipe_id: 1,
    serving_count: servingCount,
    cooking_minutes: 20,
    name,
    slug: name.toLowerCase(),
    units: 'Metric',
    thumbnail_image_url: '',
    presentation_image_url: '',
    cookwares: [],
    instructions: [],
    line_items: lines.map(([quantity, ingredient_name], i): LineItem => ({
      id: i,
      quantity,
      ingredient_name,
    })),
    nutrition: {} as RecipeDoc['nutrition'],
  }
}

function input(d: RecipeDoc, factor: number): AggregateInput {
  return { doc: d, factor, recipeName: d.name }
}

function displays(docs: AggregateInput[], ingredient: string): string[] {
  const item = aggregateGroceries(docs).find((i) => i.normalized === ingredient)
  return item ? item.lines.map((l) => l.display) : []
}

describe('aggregateGroceries container units (ADR-0017)', () => {
  test('a single recipe at its own servings keeps the authored text', () => {
    const docs = [input(doc('A', 6, [['½ (142 g) pkg', 'spinach'], ['1 head', 'cabbage']]), 1)]
    expect(displays(docs, 'spinach')).toEqual(['½ (142 g) pkg'])
    expect(displays(docs, 'cabbage')).toEqual(['1 head'])
  })

  test('two half packages merge into one purchasable package', () => {
    const docs = [
      input(doc('A', 6, [['½ (142 g) pkg', 'spinach']]), 1),
      input(doc('B', 4, [['½ (142 g) pkg', 'spinach']]), 1),
    ]
    expect(displays(docs, 'spinach')).toEqual(['1 (142 g) pkg'])
  })

  test('half + three quarters keeps the fraction and pluralizes', () => {
    const docs = [
      input(doc('A', 6, [['½ (142 g) pkg', 'spinach']]), 1),
      input(doc('B', 4, [['¾ (142 g) pkg', 'spinach']]), 1),
    ]
    expect(displays(docs, 'spinach')).toEqual(['1 ¼ (142 g) pkgs'])
  })

  test('different annotations stay on separate lines', () => {
    const docs = [
      input(doc('A', 6, [['½ (142 g) pkg', 'cheese']]), 1),
      input(doc('B', 4, [['1 (227 g) pkg', 'cheese']]), 1),
    ]
    expect(displays(docs, 'cheese').sort()).toEqual(['1 (227 g) pkg', '½ (142 g) pkg'])
  })

  test('serving a container ingredient up rounds to a whole container', () => {
    const docs = [input(doc('A', 6, [['½ small bunch', 'cilantro']]), 2)]
    expect(displays(docs, 'cilantro')).toEqual(['1 small bunch'])
    const halved = [input(doc('B', 12, [['1 small bunch', 'cilantro']]), 1)]
    expect(displays(halved, 'cilantro')).toEqual(['1 small bunch'])
  })

  test('spoon and count units keep linear scaling', () => {
    const docs = [
      input(doc('A', 6, [['2 cups', 'milk'], ['3 cloves', 'garlic'], ['1 tsp', 'salt']]), 1),
      input(doc('B', 6, [['1 cup', 'milk'], ['2 cloves', 'garlic'], ['1 tsp', 'salt']]), 1),
    ]
    expect(displays(docs, 'milk')).toEqual(['3 cups'])
    expect(displays(docs, 'garlic')).toEqual(['5 cloves'])
  })

  test('a container row and a spoon row for one ingredient coexist', () => {
    const docs = [
      input(doc('A', 6, [['½ (142 g) pkg', 'cheese']]), 1),
      input(doc('B', 4, [['30 g', 'cheese']]), 1),
    ]
    expect(displays(docs, 'cheese').sort()).toEqual(['30 g', '½ (142 g) pkg'])
  })

  test('cleared ingredients stay out but other meals still count', () => {
    const a = doc('A', 6, [['1 head', 'cabbage']])
    const b = doc('B', 4, [['2 heads', 'cabbage']])
    const items = aggregateGroceries([
      { ...input(a, 1), cleared: new Set(['cabbage']) },
      input(b, 1),
    ])
    expect(items).toHaveLength(1)
    expect(items[0].lines.map((l) => l.display)).toEqual(['2 heads'])
    expect(items[0].recipes).toEqual(['B'])
  })

  test('line keys stay unique and checkbox-stable', () => {
    const docs = [input(doc('A', 6, [['1 head', 'cabbage'], ['1 large head', 'cabbage']]), 1)]
    const lines = aggregateGroceries(docs)[0].lines
    expect(lines.map((l) => l.key)).toEqual(['cabbage||1 head', 'cabbage||1 large head'])
  })
})

describe('grocery key basis — ADR-0055 glyphs never re-key a checked line', () => {
  test('a fractional by-unit line keys on the decimal spelling, renders glyphs', () => {
    const d = doc('Scones', 1, [['1.5 cups', 'milk']])
    const [line] = aggregateGroceries([input(d, 1)])[0].lines
    // The key keeps formatAmount's decimal spelling — the spelling every
    // persisted `checked` key used before ADR-0055's glyph rendering — so
    // the render change cannot silently uncheck a fractional line.
    expect(line.key).toBe('milk||1.5 cups')
    expect(line.display).toBe('1 ½ cups')
  })

  test('an integer by-unit line keeps key and display identical', () => {
    const d = doc('Soup', 1, [['2 cups', 'stock']])
    const [line] = aggregateGroceries([input(d, 1)])[0].lines
    expect(line.key).toBe('stock||2 cups')
    expect(line.display).toBe('2 cups')
  })
})

/* ---------- Dietary restrictions: the key/display split ---------- */

describe('aggregateGroceries displayNames (the restriction ADR)', () => {
  const gfDoc = doc('Pasta Night', 6, [['15 oz', 'rotini pasta'], ['2 tbsp', 'soy sauce']])

  test('a swapped ingredient groups under the ORIGINAL nameKey but renders the substituted name', () => {
    const inputs: AggregateInput[] = [
      {
        ...input(gfDoc, 1),
        displayNames: ['gluten-free rotini pasta', 'tamari soy sauce'],
      },
    ]
    const items = aggregateGroceries(inputs)
    // The group KEY is the base ingredient's nameKey…
    expect(items.find((i) => i.normalized === 'rotini pasta')).toBeDefined()
    expect(items.find((i) => i.normalized === 'soy sauce')).toBeDefined()
    // …and the DISPLAYED name is the substituted one.
    expect(items.find((i) => i.normalized === 'rotini pasta')?.name).toBe('gluten-free rotini pasta')
    expect(items.find((i) => i.normalized === 'soy sauce')?.name).toBe('tamari soy sauce')
  })

  test('a substituted line still MERGES with the same base ingredient from another meal', () => {
    const plainDoc = doc('Stir Fry', 6, [['2 tbsp', 'soy sauce']])
    const inputs: AggregateInput[] = [
      { ...input(gfDoc, 1), displayNames: ['gluten-free rotini pasta', 'tamari soy sauce'] },
      input(plainDoc, 1),
    ]
    const soy = aggregateGroceries(inputs).find((i) => i.normalized === 'soy sauce')
    expect(soy).toBeDefined()
    // Both meals contributed to ONE group keyed by the base nameKey.
    expect(soy!.recipes.length).toBe(2)
  })

  test('cleared keys still follow the BASE name', () => {
    const inputs: AggregateInput[] = [
      {
        ...input(gfDoc, 1),
        displayNames: ['gluten-free rotini pasta', 'tamari soy sauce'],
        cleared: new Set(['soy sauce']),
      },
    ]
    // The cleared key is the base nameKey; the overridden display never
    // changes what clearing hides.
    expect(aggregateGroceries(inputs).find((i) => i.normalized === 'soy sauce')).toBeUndefined()
    expect(aggregateGroceries(inputs).find((i) => i.normalized === 'rotini pasta')).toBeDefined()
  })

  test('no overrides: the base names render as before', () => {
    expect(displays([input(gfDoc, 1)], 'rotini pasta')).toEqual(['15 oz'])
    const items = aggregateGroceries([input(gfDoc, 1)])
    expect(items.find((i) => i.normalized === 'rotini pasta')?.name).toBe('rotini pasta')
  })
})
