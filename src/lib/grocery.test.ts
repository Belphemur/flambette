import { describe, expect, test } from 'bun:test'
import {
  aggregateGroceries,
  aggregateRowKeys,
  clearedEntryForCheckedLine,
  clearedEntryFromKey,
  clearedSpellingsDiverge,
  lineKeyIdentity,
  mealSurvivingLines,
  migrateClearedMap,
  type AggregateInput,
  type ClearedIngredient,
  type RestrictedDisplayLine,
} from './grocery'
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

/** The whole-ingredient (row) claim a bare nameKey stamps (ADR-0094). */
function rowCleared(d: RecipeDoc, keyName: string): ClearedIngredient {
  return { keyName, unit: { kind: 'row' }, factor: 1, servingsAtClear: d.serving_count, scope: 'ingredient' }
}

/**
 * The ADR-0094 cleared entries for a rendered line list, carrying the
 * clear-time context a REAL capture stamps (non-approx): the clear
 * happened at `clearFactor` servings of the doc, so the entries mirror
 * what `clearedEntryForCheckedLine` mints from a snapshot's own lines.
 */
function clearedEntries(d: RecipeDoc, cleared: string[], clearFactor = 1): ClearedIngredient[] {
  return cleared
    .map((key) => clearedEntryFromKey(key))
    .filter((e): e is ClearedIngredient => e !== null)
    .map((e) => {
      const { approx: _approx, ...rest } = e
      return { ...rest, factor: clearFactor, servingsAtClear: d.serving_count * clearFactor }
    })
}

function inputDisplay(d: RecipeDoc, factor: number, rows: RestrictedDisplayLine[], cleared?: string[]): AggregateInput {
  return {
    doc: d,
    factor,
    recipeName: 'A',
    displayLines: rows,
    cleared: cleared?.length ? clearedEntries(d, cleared) : undefined,
  }
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
      { ...input(a, 1), cleared: [rowCleared(a, 'cabbage')] },
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

describe('aggregateGroceries displayLines (the restriction ADR)', () => {
  const gfDoc = doc('Pasta Night', 6, [['15 oz', 'rotini pasta'], ['2 tbsp', 'soy sauce']])

  test('a swapped ingredient groups under the ORIGINAL nameKey but renders the substituted name', () => {
    const inputs: AggregateInput[] = [
      {
        ...input(gfDoc, 1),
        displayLines: [
          { keyName: 'rotini pasta', name: 'gluten-free rotini pasta', quantity: '15 oz' },
          { keyName: 'soy sauce', name: 'tamari soy sauce', quantity: '2 tbsp' },
        ],
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
      {
        ...input(gfDoc, 1),
        displayLines: [
          { keyName: 'rotini pasta', name: 'gluten-free rotini pasta', quantity: '15 oz' },
          { keyName: 'soy sauce', name: 'tamari soy sauce', quantity: '2 tbsp' },
        ],
      },
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
        displayLines: [
          { keyName: 'rotini pasta', name: 'gluten-free rotini pasta', quantity: '15 oz' },
          { keyName: 'soy sauce', name: 'tamari soy sauce', quantity: '2 tbsp' },
        ],
        cleared: [rowCleared(gfDoc, 'soy sauce')],
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

  test('a display row is NEVER a cross-pair: its name and quantity come from one doc', () => {
    // The mis-pairing bug class: `6 cloves gluten-free fettuccine pasta`
    // (base quantity under an overlay name). A display row carries BOTH from
    // the same source, so the aggregation can only ever render pairs that
    // co-occur in one authoritative doc.
    const inputs: AggregateInput[] = [
      {
        ...input(gfDoc, 1),
        displayLines: [
          { keyName: 'rotini pasta', name: 'gluten-free rotini pasta', quantity: '425 g' },
          { keyName: 'soy sauce', name: 'tamari soy sauce', quantity: '2 tbsp' },
        ],
      },
    ]
    const pasta = aggregateGroceries(inputs).find((i) => i.normalized === 'rotini pasta')
    expect(pasta?.name).toBe('gluten-free rotini pasta')
    expect(displays(inputs, 'rotini pasta')).toEqual(['425 g'])
  })

  test('a re-authored overlay amount DISPLAYS the overlay quantity but KEYS the base spelling', () => {
    // Upstream re-authors amounts too (GF rid 1155: `6` eggs -> `12` eggs).
    // The display follows the overlay; the checkbox key derives from the
    // BASE line, so toggling the restriction renders the base quantity under
    // the SAME key and the check survives.
    const inputs: AggregateInput[] = [
      {
        ...input(gfDoc, 1),
        displayLines: [
          { keyName: 'egg', name: 'eggs', quantity: '12', keyQuantity: '6' },
        ],
      },
    ]
    const agg = aggregateGroceries(inputs)
    expect(agg.find((i) => i.normalized === 'egg')?.lines[0].display).toBe('12')
    // The base render's own key, derived independently:
    const baseInputs: AggregateInput[] = [input(doc('Plain', 6, [['6', 'eggs']]), 1)]
    const baseKey = aggregateGroceries(baseInputs).find((i) => i.normalized === 'egg')!.lines[0].key
    expect(agg.find((i) => i.normalized === 'egg')?.lines[0].key).toBe(baseKey)
  })

  test('a re-authored container amount keys on the base container spelling', () => {
    const inputs: AggregateInput[] = [
      {
        ...input(gfDoc, 1),
        displayLines: [
          {
            keyName: 'mozzarella cheese',
            name: 'mozzarella cheese',
            quantity: '1 ½ (227 g) blocks',
            keyQuantity: '1 (227 g) block',
          },
        ],
      },
    ]
    const agg = aggregateGroceries(inputs)
    expect(agg.find((i) => i.normalized === 'mozzarella cheese')?.lines[0].display).toBe(
      '1 ½ (227 g) blocks',
    )
    const baseInputs: AggregateInput[] = [input(doc('Plain', 6, [['1 (227 g) block', 'mozzarella cheese']]), 1)]
    const baseKey = aggregateGroceries(baseInputs).find((i) => i.normalized === 'mozzarella cheese')!.lines[0].key
    expect(agg.find((i) => i.normalized === 'mozzarella cheese')?.lines[0].key).toBe(baseKey)
  })

  test('an unparseable display quantity keys on the base spelling (the raw branch)', () => {
    // The raw branch (display quantity unparseable, e.g. an overlay line
    // with an empty quantity) must still spell its key the way the BASE
    // render would — the base `6` eggs line PARSES, so a `raw||` key here
    // would orphan the checked line on toggle.
    const eggsDoc = doc('Quiche', 6, [['6', 'eggs']])
    const baseKey = aggregateGroceries([input(eggsDoc, 1)]).find((i) => i.normalized === 'egg')!.lines[0].key
    const agg = aggregateGroceries([
      {
        ...input(eggsDoc, 1),
        displayLines: [
          { keyName: 'egg', name: 'egg', quantity: '', keyQuantity: '6', keyIngredient: 'eggs' },
        ],
      },
    ])
    const line = agg.find((i) => i.normalized === 'egg')!.lines[0]
    expect(line.display).toBe('')
    expect(line.key).toBe(baseKey)
  })

  test('the KEY side classifies by the BASE ingredient, not the substitute', () => {
    // The base `6 g paprika` line is a seasoning (sub-linear rule); the
    // substitute's name carries no seasoning keyword. Classifying the key
    // side by the DISPLAY name would scale it linearly and re-spell the
    // key away from what the base render spells.
    const spiced = doc('Spiced', 6, [['6 g', 'paprika']])
    const factor = 2 / 6
    const baseKey = aggregateGroceries([input(spiced, factor)]).find((i) => i.normalized === 'paprika')!.lines[0].key
    const agg = aggregateGroceries([
      {
        ...input(spiced, factor),
        displayLines: [
          { keyName: 'paprika', name: 'spice blend', quantity: '5 g', keyQuantity: '6 g', keyIngredient: 'paprika' },
        ],
      },
    ])
    expect(agg.find((i) => i.normalized === 'paprika')!.lines[0].key).toBe(baseKey)
  })

  test('a raw-display row whose parsed key collides with a by-unit line dedupes (keys stay unique)', () => {
    // Restricted meal A: the overlay blanks the quantity while keyQuantity
    // keeps the base `6`; unrestricted meal B contributes its own `6`. Both
    // would key `egg||6` — the by-unit line (a real display) is pushed
    // first and wins; the raw row's blank display is dropped, never a
    // second line silently sharing the checkbox key.
    const a = doc('Restricted Quiche', 6, [['6', 'eggs']])
    const b = doc('Plain Omelette', 6, [['6', 'eggs']])
    const agg = aggregateGroceries([
      {
        ...input(a, 1),
        displayLines: [{ keyName: 'egg', name: 'egg', quantity: '', keyQuantity: '6', keyIngredient: 'eggs' }],
      },
      input(b, 1),
    ])
    const egg = agg.find((i) => i.normalized === 'egg')!
    expect(egg.lines).toHaveLength(1)
    expect(egg.lines[0].key).toBe('egg||6')
    expect(egg.lines[0].display).toBe('6')
  })

  test('a colliding raw row with a REAL display re-namespaces instead of being dropped', () => {
    // The dedupe only swallows a BLANK colliding display: a raw row whose
    // key source parses but whose display carries real text coexists with
    // the by-unit line under the raw|| namespace — no contribution lost.
    const a = doc('Restricted Quiche', 6, [['6', 'eggs']])
    const b = doc('Plain Omelette', 6, [['6', 'eggs']])
    const agg = aggregateGroceries([
      {
        ...input(a, 1),
        displayLines: [
          { keyName: 'egg', name: 'egg', quantity: 'a pinch', keyQuantity: '6', keyIngredient: 'eggs' },
        ],
      },
      input(b, 1),
    ])
    const egg = agg.find((i) => i.normalized === 'egg')!
    expect(egg.lines).toHaveLength(2)
    expect(egg.lines.map((l) => l.key)).toEqual(['egg||6', 'egg||raw||6'])
    expect(egg.lines.map((l) => l.display)).toEqual(['6', 'a pinch'])
  })

  test('divergent substitutes label the merged group with EVERY name', () => {
    // Two planned meals, the same BASE ingredient, different substitutes —
    // a first-seen-only label would claim the whole summed quantity for one
    // substitute. The quantity still merges (splitting by name would
    // re-key checked state on toggle); the label names them all.
    const a = doc('Tamari Stir Fry', 6, [['2 tbsp', 'soy sauce']])
    const b = doc('Aminos Bowl', 6, [['2 tbsp', 'soy sauce']])
    const agg = aggregateGroceries([
      {
        ...input(a, 1),
        displayLines: [{ keyName: 'soy sauce', name: 'tamari', quantity: '2 tbsp', keyIngredient: 'soy sauce' }],
      },
      {
        ...input(b, 1),
        displayLines: [{ keyName: 'soy sauce', name: 'coconut aminos', quantity: '2 tbsp', keyIngredient: 'soy sauce' }],
      },
    ])
    const soy = agg.find((i) => i.normalized === 'soy sauce')!
    expect(soy.name).toBe('tamari / coconut aminos')
    expect(soy.lines.map((l) => l.display)).toEqual(['4 tbsp'])
  })
})

describe('aggregateGroceries line-granular clears (ADR-0092, PR #94)', () => {
  const clearedInput = (d: RecipeDoc, factor: number, cleared: string[]): AggregateInput => ({
    ...input(d, factor),
    cleared: clearedEntries(d, cleared),
  })

  test('a cleared FULL line key hides only that rendered line', () => {
    const d = doc('A', 4, [['2 tbsp', 'soy sauce'], ['30 ml', 'soy sauce']])
    const docs = [clearedInput(d, 1, ['soy sauce||2 tbsp'])]
    // The checked `2 tbsp` line is gone; the unchecked `30 ml` sibling stays.
    expect(displays(docs, 'soy sauce')).toEqual(['30 ml'])
  })

  test('a cleared bare nameKey keeps the whole-ingredient row-level skip', () => {
    const d = doc('A', 4, [['2 tbsp', 'soy sauce'], ['30 ml', 'soy sauce']])
    const docs = [clearedInput(d, 1, ['soy sauce'])]
    expect(displays(docs, 'soy sauce')).toEqual([])
  })

  test('a group whose every line is cleared disappears entirely', () => {
    const d = doc('A', 4, [['2 tbsp', 'soy sauce'], ['30 ml', 'soy sauce']])
    const docs = [
      clearedInput(d, 1, ['soy sauce||2 tbsp', 'soy sauce||30 ml']),
    ]
    expect(aggregateGroceries(docs).find((i) => i.normalized === 'soy sauce')).toBeUndefined()
  })

  test('the cleared line key names the MERGED render — other meals share the hide', () => {
    const a = doc('A', 4, [['1 tbsp', 'soy sauce']])
    const b = doc('B', 4, [['2 tbsp', 'soy sauce'], ['30 ml', 'soy sauce']])
    // Each contributor's claim carries its OWN share of the merged line;
    // the claims SUM to exactly what the render produced (3 tbsp), so the
    // merged line hides while the `30 ml` sibling stays.
    const docs = [
      { ...input(a, 1), cleared: clearedEntries(a, ['soy sauce||1 tbsp']) },
      clearedInput(b, 1, ['soy sauce||2 tbsp']),
    ]
    expect(displays(docs, 'soy sauce')).toEqual(['30 ml'])
  })

  test('a merged container line hides when the claims sum to it (the soy-pkg case)', () => {
    // Two recipes each contributing one package: the merged render is
    // `2 pkgs`; each variant's container claim carries its own count, the
    // claims sum to 2, and the merged container line hides.
    const a = doc('A', 6, [['1 pkg', 'soy sauce']])
    const b = doc('B', 6, [['1 pkg', 'soy sauce']])
    const docs = [
      { ...input(a, 1), cleared: clearedEntries(a, ['soy sauce||1 pkg']) },
      { ...input(b, 1), cleared: clearedEntries(b, ['soy sauce||1 pkg']) },
    ]
    expect(displays(docs, 'soy sauce')).toEqual([])
  })

  test('a legacy `milk||1cup` spelling hides the rendered `milk||1 cup` line', () => {
    // The migration parses the legacy basis with the render's own parser,
    // so the spelling the string model persisted (no space) claims the
    // same cup bucket the render produced (spaced).
    const d = doc('A', 4, [['1 cup', 'milk']])
    const docs = [clearedInput(d, 1, ['milk||1cup'])]
    expect(displays(docs, 'milk')).toEqual([])
  })
})

describe('cleared claims survive composition changes (ADR-0094)', () => {
  const clearedInput = (d: RecipeDoc, factor: number, cleared: string[]): AggregateInput => ({
    ...input(d, factor),
    cleared: clearedEntries(d, cleared),
  })

  test('a STALE cleared claim still hides the re-summed line after a co-contributor leaves', () => {
    // A and B both contributed to the summed `3 tbsp` line; the household
    // cleared it (each claim carrying its own share); A was cooked (its
    // cleared row is forgotten WITH its input) and B's claim — own share
    // 2 tbsp — still accounts for exactly the re-summed `2 tbsp` line.
    const a = doc('A', 4, [['1 tbsp', 'soy sauce']])
    const b = doc('B', 4, [['2 tbsp', 'soy sauce']])
    const merged = [
      { ...input(a, 1), cleared: clearedEntries(a, ['soy sauce||1 tbsp']) },
      { ...input(b, 1), cleared: clearedEntries(b, ['soy sauce||2 tbsp']) },
    ]
    expect(displays(merged, 'soy sauce')).toEqual([])
    // After A leaves, the re-summed line is B's own share — still hidden.
    const after = [{ ...input(b, 1), cleared: clearedEntries(b, ['soy sauce||2 tbsp']) }]
    expect(displays(after, 'soy sauce')).toEqual([])
  })

  test('the stale-key hide is UNIT-scoped: an unchecked sibling line survives a serving bump', () => {
    const d = doc('A', 4, [['2 tbsp', 'soy sauce'], ['30 ml', 'soy sauce']])
    // `2 tbsp` was cleared at the authored servings; doubling the plan
    // re-sums to `4 tbsp` + `60 ml`. Only the tbsp line stays hidden.
    const docs = [clearedInput(d, 2, ['soy sauce||2 tbsp'])]
    expect(displays(docs, 'soy sauce')).toEqual(['60 ml'])
  })

  test('a container line stays hidden across a serving bump (container identity)', () => {
    const d = doc('A', 6, [['½ (142 g) pkg', 'spinach']])
    // Cleared at the authored render (`½ (142 g) pkg`); doubling re-sums
    // to `1 (142 g) pkg` — a different basis, the same (pkg, 142 g) line.
    const docs = [clearedInput(d, 2, ['spinach||½ (142 g) pkg'])]
    expect(displays(docs, 'spinach')).toEqual([])
  })

  test('a stale container key with a DIFFERENT annotation never hides the other line', () => {
    const docs = [
      clearedInput(doc('A', 6, [['½ (142 g) pkg', 'cheese']]), 1, ['cheese||½ (227 g) pkg']),
    ]
    expect(displays(docs, 'cheese')).toEqual(['½ (142 g) pkg'])
  })

  test('a UNITLESS cleared amount stays hidden across a re-sum (kody round-2 re-review)', () => {
    const d = doc('A', 4, [['2', 'egg']])
    // Cleared `egg||2` at the authored servings; doubling re-sums to `4`
    // — the amount-free unit identity (`egg||`) keeps the line hidden.
    const docs = [clearedInput(d, 2, ['egg||2'])]
    expect(displays(docs, 'egg')).toEqual([])
  })

  test('a raw row and a by-unit line are separate grammar branches: clearing one leaves the sibling visible (kody round-3, K5)', () => {
    // The restriction overlay can render TWO lines of one ingredient in a
    // single meal: a by-unit row (`egg||4`) beside a raw row whose key
    // basis parses unitless (`egg||6`, display `to taste`). The claims are
    // BRANCH-scoped — a by-unit claim can never hide a raw row beside it
    // and vice versa — so only the cleared line disappears.
    const base = doc('A', 4, [])
    const rows: RestrictedDisplayLine[] = [
      { keyName: 'egg', name: 'egg', quantity: '4' },
      { keyName: 'egg', name: 'egg (to taste)', quantity: 'to taste', keyQuantity: '6' },
    ]
    // The raw claim goes through the REAL capture (clearedEntryForCheckedLine
    // with the checked line's display) — the key basis alone would
    // misclassify the `raw||6` row as a by-unit claim.
    const rawViaCapture = clearedEntryForCheckedLine(
      'egg',
      { key: 'egg||6', display: 'to taste' },
      undefined,
      { servings: base.serving_count, factor: 1 },
    )
    expect(rawViaCapture?.unit.kind).toBe('raw')
    expect(displays([{ ...inputDisplay(base, 1, rows), cleared: rawViaCapture ? [rawViaCapture] : [] }], 'egg')).toEqual(['4'])
    expect(displays([inputDisplay(base, 1, rows, ['egg||4'])], 'egg')).toEqual(['to taste'])
    expect(displays([inputDisplay(base, 1, rows)], 'egg')).toEqual(['4', 'to taste'])
  })

  test('a serving bump after a sibling-scoped clear keeps the rotated line hidden (K5 + K1 together)', () => {
    // The case the identity model could not express: `egg||4` was cleared
    // beside a raw `egg||6` sibling, then the bump re-sums the by-unit
    // line to `egg||8`. The identity now names TWO rendered lines, so the
    // old fallback-to-exact gave up and the rotated line REAPPEARED; the
    // object claim re-derives its successor (4 eggs at the authored
    // servings -> 8 at double) and hides exactly that line.
    const base = doc('A', 4, [])
    const rows: RestrictedDisplayLine[] = [
      { keyName: 'egg', name: 'egg', quantity: '4' },
      { keyName: 'egg', name: 'egg (to taste)', quantity: 'to taste', keyQuantity: '6' },
    ]
    expect(displays([inputDisplay(base, 2, rows, ['egg||4'])], 'egg')).toEqual(['to taste'])
  })

  test('a singleton identity still hides composition-stale re-sums (K1 unchanged by the K5 guard)', () => {
    // The guard must not weaken K1: one rendered line whose identity
    // matches the stale cleared key is still hidden.
    const docs = [clearedInput(doc('A', 4, [['2', 'egg']]), 2, ['egg||2'])]
    expect(displays(docs, 'egg')).toEqual([])
  })

  test('a singular/plural unit spelling does not split the identity (kody round-2 re-review)', () => {
    // B is aggregated FIRST, so the merged line spells the plural `cups`
    // while A's own render spells `1 cup` — the parsed-unit identity
    // collapses both to `cup`, so A's contribution is still counted.
    const a = doc('A', 4, [['1 cup', 'milk']])
    const b = doc('B', 4, [['2 cups', 'milk']])
    const docs = [input(b, 1), input(a, 1)]
    const merged = aggregateGroceries(docs).find((i) => i.normalized === 'milk')!
    expect(merged.lines.map((l) => l.key)).toEqual(['milk||3 cups'])
    const visible = new Map([
      ['milk', new Set(merged.lines.map((l) => lineKeyIdentity(l.key)))],
    ])
    expect(mealSurvivingLines(input(a, 1), visible)).toBe(1)
  })
})

describe('mealSurvivingLines (Contributing Meals card, ADR-0092 round 2, kody K2)', () => {
  const clearedInput = (d: RecipeDoc, factor: number, cleared: string[]): AggregateInput => ({
    ...input(d, factor),
    cleared: clearedEntries(d, cleared),
  })

  /** The merged render's per-group surviving line identities, from one pass. */
  function visibleIdentities(docs: AggregateInput[]): Map<string, Set<string>> {
    return new Map(
      aggregateGroceries(docs).map((i) => [
        i.normalized,
        new Set(i.lines.map((line) => lineKeyIdentity(line.key))),
      ]),
    )
  }

  test('a two-line ingredient counts its surviving lines: partial clear drops the count by exactly 1', () => {
    const d = doc('A', 4, [['2 tbsp', 'soy sauce'], ['30 ml', 'soy sauce']])
    expect(mealSurvivingLines(input(d, 1), visibleIdentities([input(d, 1)]))).toBe(2)
    const cleared = [clearedInput(d, 1, ['soy sauce||2 tbsp'])]
    expect(mealSurvivingLines(cleared[0], visibleIdentities(cleared))).toBe(1)
  })

  test('two meals using the same ingredient in DIFFERENT units each count only their own line', () => {
    const a = doc('A', 4, [['2 tbsp', 'soy sauce']])
    const b = doc('B', 4, [['30 ml', 'soy sauce']])
    const docs = [input(a, 1), input(b, 1)]
    const visible = visibleIdentities(docs)
    // The merged group renders two lines; each meal contributes one.
    expect(mealSurvivingLines(docs[0], visible)).toBe(1)
    expect(mealSurvivingLines(docs[1], visible)).toBe(1)
  })

  test('a cleared shared line drops only the meals whose own unit line it hid', () => {
    const a = doc('A', 4, [['2 tbsp', 'soy sauce']])
    const b = doc('B', 4, [['30 ml', 'soy sauce']])
    const cleared = [clearedInput(a, 1, ['soy sauce||2 tbsp']), input(b, 1)]
    const visible = visibleIdentities(cleared)
    // The merged tbsp line is hidden; A contributed nothing that survives,
    // B's ml line is untouched.
    expect(mealSurvivingLines(cleared[0], visible)).toBe(0)
    expect(mealSurvivingLines(cleared[1], visible)).toBe(1)
  })

  test('a fully cleared group is gone from the render and counts zero', () => {
    const d = doc('A', 4, [['2 tbsp', 'soy sauce']])
    const cleared = [clearedInput(d, 1, ['soy sauce||2 tbsp'])]
    expect(mealSurvivingLines(cleared[0], visibleIdentities(cleared))).toBe(0)
  })

  test('a bare-cleared row counts zero even when the merged group survives on other meals', () => {
    const a = doc('A', 4, [['1 tbsp', 'soy sauce']])
    const b = doc('B', 4, [['2 tbsp', 'soy sauce']])
    // A bare-cleared soy sauce for A; B's contribution keeps the group alive.
    const docs = [clearedInput(a, 1, ['soy sauce']), input(b, 1)]
    expect(mealSurvivingLines(docs[0], visibleIdentities(docs))).toBe(0)
    expect(mealSurvivingLines(docs[1], visibleIdentities(docs))).toBe(1)
  })
})

describe('cleared successors re-derive through the render itself (ADR-0094 review)', () => {
  /** A captured (non-approx) claim exactly as clearCheckedItems mints it. */
  const claim = (entry: ClearedIngredient): ClearedIngredient => entry

  test('a container claim re-derives the CEIL from the authored count, never rescales the captured render (#1)', () => {
    // Authored ½ pkg; at factor 3 the render ceils to 2 pkgs and the
    // household clears that line. Back at factor 2 the render produces
    // ceil(½×2) = 1 pkg. Rescaling the CAPTURED 2 by ⅔ would predict 2 and
    // leave the line visible; the shadow render predicts 1 and hides it.
    const d = doc('A', 6, [['½ (142 g) pkg', 'spinach']])
    const capturedAt3 = claim({
      keyName: 'spinach',
      unit: { kind: 'container', noun: 'pkg', annotation: '(142 g)', count: 2 },
      factor: 3,
      servingsAtClear: 18,
      scope: 'line',
    })
    expect(displays([{ ...input(d, 3), cleared: [capturedAt3] }], 'spinach')).toEqual([])
    expect(displays([{ ...input(d, 2), cleared: [capturedAt3] }], 'spinach')).toEqual([])
    expect(displays([{ ...input(d, 2) }], 'spinach')).toEqual(['1 (142 g) pkg'])
  })

  test('claims are SCOPED to their ingredient: clearing cornstarch never hides flour (#2)', () => {
    // Two ingredients sharing the unit basis `1 cup`. The pre-review
    // buckets keyed by unit alone, so one claim hid (or unsummed) both
    // lines. Bucket keys carry the claim's keyName now.
    const flour = doc('A', 4, [['1 cup', 'flour']])
    const starch = doc('B', 4, [['1 cup', 'cornstarch']])
    const docs = [
      input(flour, 1),
      { ...input(starch, 1), cleared: clearedEntries(starch, ['cornstarch||1 cup']) },
    ]
    expect(displays(docs, 'cornstarch')).toEqual([])
    expect(displays(docs, 'flour')).toEqual(['1 cup'])
  })

  test('raw-branch claims are scoped too: clearing one `to taste` row leaves the sibling visible (#2)', () => {
    const a = doc('A', 4, [['to taste', 'salt']])
    const b = doc('B', 4, [['to taste', 'pepper']])
    const docs = [
      input(a, 1),
      { ...input(b, 1), cleared: clearedEntries(b, ['pepper||raw||to taste']) },
    ]
    expect(displays(docs, 'pepper')).toEqual([])
    expect(displays(docs, 'salt')).toEqual(['to taste'])
  })

  test('a cleared seasoning stays hidden after a servings change: the successor IS the shadow render (#3)', () => {
    // ADR-0009 scales seasonings sub-linearly — a linear ratio of the
    // captured amount predicts a key the render never spells.
    const d = doc('A', 2, [['2 tsp', 'salt']])
    const at2 = displays([input(d, 2)], 'salt')
    expect(at2).not.toEqual(['2 tsp'])
    const docs = [{ ...input(d, 2), cleared: clearedEntries(d, [`salt||${at2[0]}`], 2) }]
    expect(displays(docs, 'salt')).toEqual([])
    // The claim persists: at a DIFFERENT servings the sub-linear rule may
    // land on the same spoon count — the cleared line stays hidden either
    // way, because the successor is the shadow render, never a ratio.
    const docs3 = [{ ...input(d, 3), cleared: clearedEntries(d, [`salt||${at2[0]}`], 2) }]
    expect(displays(docs3, 'salt')).toEqual([])
  })

  test('a cleared metric quantity survives quantization: 2129 ml ×⅔ renders 1420 ml on BOTH sides (#3)', () => {
    const d = doc('A', 3, [['2129 ml', 'water']])
    // Cleared at the authored render; shrinking to ⅔ re-quantizes through
    // scaleMetricAmount's cup/fl-oz grid (1420, not the linear 1419.3).
    const docs = [{ ...input(d, 2 / 3), cleared: clearedEntries(d, ['water||2129 ml']) }]
    expect(displays([input(d, 2 / 3)], 'water')).toEqual(['1420 ml'])
    expect(displays(docs, 'water')).toEqual([])
  })

  test('the owner contract: a merged clear hides every contributor, a partial clear keeps the line', () => {
    // "1.5 medium head + 2.5 medium head shows 4 medium heads; checking
    // off 4 checks off everything" — container claims sum per bucket.
    const a = doc('A', 4, [['1.5 medium head', 'cabbage']])
    const b = doc('B', 4, [['2.5 medium head', 'cabbage']])
    const full = [
      { ...input(a, 1), cleared: clearedEntries(a, ['cabbage||1.5 medium head']) },
      { ...input(b, 1), cleared: clearedEntries(b, ['cabbage||2.5 medium head']) },
    ]
    expect(displays(full, 'cabbage')).toEqual([])
    // A partial clear (one contributor) sums to less than the merged
    // line — the line stays visible.
    const partial = [
      { ...input(a, 1), cleared: clearedEntries(a, ['cabbage||1.5 medium head']) },
      input(b, 1),
    ]
    expect(displays(partial, 'cabbage')).toEqual(['4 medium heads'])
  })
})

describe('legacy migration mints approx identity claims (ADR-0094 review)', () => {
  const migratedInput = (d: RecipeDoc, factor: number, cleared: string[]): AggregateInput => ({
    ...input(d, factor),
    cleared: migrateClearedMap({ 1: cleared })[1],
  })

  test('legacy keys migrate to approx claims: no serving context is invented (#4)', () => {
    const out = migrateClearedMap({ 7: ['egg||4', 'flour'] })
    expect(out[7]).toEqual([
      {
        keyName: 'egg',
        unit: { kind: 'byUnit', unit: '', amount: 4 },
        factor: 1,
        servingsAtClear: 0,
        scope: 'line',
        approx: true,
      },
      {
        keyName: 'flour',
        unit: { kind: 'row' },
        factor: 1,
        servingsAtClear: 0,
        scope: 'ingredient',
        approx: true,
      },
    ])
  })

  test('a migrated claim hides its line at ANY servings — the identity never rotates (#4)', () => {
    // `egg||4` was persisted under the string model at unknown servings;
    // the plan has since moved. The pre-review migration stamped the
    // CURRENT servings as the clear context and mispredicted; the approx
    // claim matches by unit identity, which no re-sum can rotate.
    const d = doc('A', 4, [['2', 'egg']])
    expect(displays([migratedInput(d, 1, ['egg||4'])], 'egg')).toEqual([])
    expect(displays([migratedInput(d, 2, ['egg||4'])], 'egg')).toEqual([])
    expect(displays([migratedInput(d, 3, ['egg||4'])], 'egg')).toEqual([])
  })

  test('the same merged string in N contributor variants mints identity claims that never sum (#5)', () => {
    // Pre-ADR-0092 clearCheckedItems pushed the MERGED key into every
    // contributor's array. Two variants each carrying `soy sauce||3 tbsp`
    // must hide the 3 tbsp line once — the pre-review migration turned
    // each into a full byUnit claim and the two summed to 6.
    const a = doc('A', 4, [['1 tbsp', 'soy sauce']])
    const b = doc('B', 4, [['2 tbsp', 'soy sauce']])
    const docs = [
      migratedInput(a, 1, ['soy sauce||3 tbsp']),
      migratedInput(b, 1, ['soy sauce||3 tbsp']),
    ]
    expect(displays(docs, 'soy sauce')).toEqual([])
  })

  test('a migrated claim stays scoped to its ingredient (#2/#5)', () => {
    const flour = doc('A', 4, [['1 cup', 'flour']])
    const starch = doc('B', 4, [['1 cup', 'cornstarch']])
    const docs = [input(flour, 1), migratedInput(starch, 1, ['cornstarch||1 cup'])]
    expect(displays(docs, 'cornstarch')).toEqual([])
    expect(displays(docs, 'flour')).toEqual(['1 cup'])
  })

  test('a legacy approx container claim does NOT hide a merged partial line (kody critical)', () => {
    // A stale `cabbage||1.5 medium head` (legacy string → approx) when B's
    // 2.5-head contribution keeps the merged line at 4 heads: the stale amount
    // must not silence the unclaimed 2.5 (pre-fix: hidden by the identity
    // short-circuit at lineClaimed's container branch).
    const a = doc('A', 4, [['1.5 medium head', 'cabbage']])
    const b = doc('B', 4, [['2.5 medium head', 'cabbage']])
    const docs = [
      migratedInput(a, 1, ['cabbage||1.5 medium head']),
      input(b, 1),
    ]
    const shown = displays(docs, 'cabbage')
    expect(shown).not.toEqual([])
    expect(shown.some((d) => /4 medium head/i.test(d))).toBe(true)
  })

  test('a legacy approx container claim still hides when it matches the merged amount', () => {
    // The household's single legacy clear named the whole merged 4-head line
    // — it must still hide the merged render (guard against over-correcting).
    const a = doc('A', 4, [['1.5 medium head', 'cabbage']])
    const b = doc('B', 4, [['2.5 medium head', 'cabbage']])
    const docs = [
      migratedInput(a, 1, ['cabbage||4 medium heads']),
      input(b, 1),
    ]
    expect(displays(docs, 'cabbage')).toEqual([])
  })

  test('a legacy approx unit-bearing claim does NOT hide a merged partial line (milk)', () => {
    // `milk||1cup` (approx) when B's 2 cups keeps the merged line at 3 cups.
    const a = doc('A', 4, [['1 cup', 'milk']])
    const b = doc('B', 4, [['2 cups', 'milk']])
    const docs = [
      migratedInput(a, 1, ['milk||1cup']),
      input(b, 1),
    ]
    const shown = displays(docs, 'milk')
    expect(shown).not.toEqual([])
    expect(shown.some((d) => /^3 cup/i.test(d))).toBe(true)
  })
  test('two legacy clears for one container identity keep both amounts (Set), hiding the matched line (kody #2)', () => {
    // `cabbage||4 medium heads` (whole-line) and `cabbage||1.5 medium head`
    // (partial) both clear the SAME container identity, carried by TWO
    // variants so the per-variant migration dedup doesn't collapse them.
    // The Map-overwrite model dropped the earlier amount; the merged `4
    // medium heads` line must still hide because the `4` clear survives in
    // the Set (kody #2, container OR-combine).
    const a = doc('A', 4, [['1.5 medium head', 'cabbage']])
    const b = doc('B', 4, [['2.5 medium head', 'cabbage']])
    const docs = [
      migratedInput(a, 1, ['cabbage||4 medium heads']),
      migratedInput(b, 1, ['cabbage||1.5 medium head']),
    ]
    expect(displays(docs, 'cabbage')).toEqual([])
  })
  test('an exact shadow that does not match must not discard a matching legacy approx amount (milk, kody #2)', () => {
    // A's captured clear (`milk||1 cup`) sums to 1; the merged line is 3 cups
    // (A 1 + B 2). A legacy approx `milk||3 cups` (B, migrated) claims the
    // whole merged total. The exact shadow must NOT short-circuit the approx
    // amount — the line hides. (Pre-fix: the byUnit `if (claim) return false`
    // discarded the matching approx and left the line visible.)
    const a = doc('A', 4, [['1 cup', 'milk']])
    const b = doc('B', 4, [['2 cups', 'milk']])
    const docs = [
      { ...input(a, 1), cleared: clearedEntries(a, ['milk||1 cup']) },
      migratedInput(b, 1, ['milk||3 cups']),
    ]
    expect(displays(docs, 'milk')).toEqual([])
  })
})

describe('clearedSpellingsDiverge (mixed-household freshness, ADR-0094 review)', () => {
  const v2 = { 7: [{ keyName: 'flour', unit: { kind: 'byUnit', unit: 'ml', amount: 67.5 }, factor: 1, servingsAtClear: 4, scope: 'line' }] }
  const legacy = { 7: ['flour||67.5 ml'] }

  test('a V2 sender\'s two spellings agree (both derive from one state)', () => {
    expect(clearedSpellingsDiverge(legacy, v2)).toBe(false)
  })

  test('a legacy peer\'s newer write disagrees with the stale V2 row', () => {
    expect(clearedSpellingsDiverge({ 7: ['fresh-key||1 cup'] }, v2)).toBe(true)
    expect(clearedSpellingsDiverge({ 7: [] }, v2)).toBe(true)
  })

  test('absent keys never diverge (the presence-decides contract stays intact)', () => {
    expect(clearedSpellingsDiverge(undefined, v2)).toBe(false)
    expect(clearedSpellingsDiverge(legacy, undefined)).toBe(false)
    expect(clearedSpellingsDiverge(undefined, undefined)).toBe(false)
  })

  test('the comparison is order-stable', () => {
    expect(clearedSpellingsDiverge({ 7: ['a||1', 'b||2'] }, { 7: [{ keyName: 'b', unit: { kind: 'byUnit', unit: '', amount: 2 }, factor: 1, servingsAtClear: 4, scope: 'line' }, { keyName: 'a', unit: { kind: 'byUnit', unit: '', amount: 1 }, factor: 1, servingsAtClear: 4, scope: 'line' }] })).toBe(false)
  })
})
