import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_UNIT_SYSTEM,
  isUnitSystem,
  localizeLine,
  localizeQuantity,
  localizeSteps,
  localizeText,
  UNIT_SYSTEMS,
} from './units'

/**
 * ADR-0047. The goldens below are the CONTRACT: the strings come from the
 * frozen catalog's real dual-notation prose (`220°C (425°F)` occurs 834
 * times, `450°F (232°C)` 21) and from its real container annotations
 * (`(142 g)`, `(398 ml)`, `(2 ½ cm)`).
 */
describe('unit system identity', () => {
  test('dual is the default and the three accepted systems are dual/metric/imperial', () => {
    expect(UNIT_SYSTEMS).toEqual(['dual', 'metric', 'imperial'])
    expect(DEFAULT_UNIT_SYSTEM).toBe('dual')
  })

  test('isUnitSystem accepts the three systems and refuses everything else', () => {
    expect(isUnitSystem('dual')).toBe(true)
    expect(isUnitSystem('metric')).toBe(true)
    expect(isUnitSystem('imperial')).toBe(true)
    for (const bad of ['', 'Metric', 'IMPERIAL', 'cups', 'metric ', null, undefined, 0, 1, {}, []]) {
      expect(isUnitSystem(bad)).toBe(false)
    }
  })

  test('DUAL is the IDENTITY everywhere — the catalog, verbatim', () => {
    for (const q of ['450 g', '1.5 kg', '250 ml', '½ (142 g) pkg', '1 (142 g) pkg', '3 (2 ½ cm) pieces', '2 cups', '3 tbsp', '6 cloves', '', 'a pinch']) {
      expect(localizeQuantity(q, 'dual')).toBe(q)
      expect(localizeLine(q, 'dual')).toBe(q)
    }
    // …including the dual temperature notation a metric/imperial reader
    // asked to collapse.
    const step = 'Preheat the oven to 220°C (425°F).'
    expect(localizeText(step, 'dual')).toBe(step)
    expect(localizeSteps([{ primary: step, details: [step] }], 'dual')).toEqual([
      { primary: step, details: [step] },
    ])
  })

  test('metric quantities are the IDENTITY — no rounding churn on any authored line', () => {
    for (const q of ['450 g', '1.5 kg', '250 ml', '½ (142 g) pkg', '1 (142 g) pkg', '3 (2 ½ cm) pieces', '3 tbsp', '6 cloves', '', 'a pinch']) {
      expect(localizeQuantity(q, 'metric')).toBe(q)
      expect(localizeLine(q, 'metric')).toBe(q)
    }
  })
})

describe('cups are purchasable VOLUME containers (owner steer, ADR-0047)', () => {
  test('a bare cup gains the mode volume through the SAME annotation grammar', () => {
    expect(localizeQuantity('1 cup', 'metric')).toBe('1 cup (240 ml)')
    expect(localizeQuantity('1 cup', 'imperial')).toBe('1 cup (8 fl oz)')
    expect(localizeQuantity('2 cups', 'metric')).toBe('2 cups (480 ml)')
    expect(localizeQuantity('2 cups', 'imperial')).toBe('2 cups (16 fl oz)')
    // A fractional count keeps its authored head (the count is purchased).
    expect(localizeQuantity('½ cup', 'metric')).toBe('½ cup (120 ml)')
  })

  test('dual leaves a cup exactly as authored', () => {
    expect(localizeQuantity('1 cup', 'dual')).toBe('1 cup')
    expect(localizeQuantity('2 cups', 'dual')).toBe('2 cups')
  })

  test('the cup count itself is NEVER converted, in either single system', () => {
    // 1 cup is 1 CUP in both modes — only its volume is annotated, so a
    // container count can never drift the way a mass does.
    expect(localizeQuantity('1 cup', 'metric')).toMatch(/^1 cup \(/)
    expect(localizeQuantity('1 cup', 'imperial')).toMatch(/^1 cup \(/)
  })

  test('an authored cup annotation is not double-annotated', () => {
    expect(localizeQuantity('1 (240 ml) cup', 'metric')).toBe('1 (240 ml) cup')
    expect(localizeQuantity('1 (8 fl oz) cup', 'imperial')).toBe('1 (8 fl oz) cup')
    // The authored annotation converts like any other; a second one is not added.
    expect(localizeQuantity('1 (240 ml) cup', 'imperial')).toBe('1 (8.1 fl oz) cup')
  })
})

describe('temperatures in prose (ADR-0047 §4)', () => {
  test('metric: the °F parenthetical restating the temperature is dropped', () => {
    expect(localizeText('Preheat oven to 220°C (425°F).', 'metric')).toBe('Preheat oven to 220°C.')
  })

  test('metric: a LEADING °F converts and its equivalent parenthetical is dropped', () => {
    // The catalog's own leading-°F pair is `450°F (232°C)`; 450°F rounds
    // to 232°C, and the brief's `230°C` form is the same restatement.
    expect(localizeText('Meanwhile, preheat oven to 450°F (232°C).', 'metric')).toBe(
      'Meanwhile, preheat oven to 232°C.',
    )
    expect(localizeText('Meanwhile, preheat oven to 450°F (230°C).', 'metric')).toBe(
      'Meanwhile, preheat oven to 230°C.',
    )
  })

  test('imperial: the mirror of both metric goldens', () => {
    expect(localizeText('Preheat oven to 220°C (425°F).', 'imperial')).toBe('Preheat oven to 425°F.')
    expect(localizeText('Meanwhile, preheat oven to 450°F (232°C).', 'imperial')).toBe(
      'Meanwhile, preheat oven to 450°F.',
    )
  })

  test('a sloppy authored pair keeps the notation the author already wrote in the target system', () => {
    // 205°C and 400°F are 0.6° apart once converted — one temperature.
    expect(localizeText('Roast at 205°C (400°F) until golden.', 'imperial')).toBe(
      'Roast at 400°F until golden.',
    )
    // 200°C / 400°F is the sloppiest authored pair in the corpus (4.4°).
    expect(localizeText('Roast at 200°C (400°F) until golden.', 'metric')).toBe(
      'Roast at 200°C until golden.',
    )
  })

  test('target-system tokens pass through untouched', () => {
    expect(localizeText('Bake at 180°C for 20 minutes.', 'metric')).toBe(
      'Bake at 180°C for 20 minutes.',
    )
    expect(localizeText('Bake at 350°F for 20 minutes.', 'imperial')).toBe(
      'Bake at 350°F for 20 minutes.',
    )
  })

  test('a lone temperature converts in the other system', () => {
    expect(localizeText('Simmer at 96°C.', 'imperial')).toBe('Simmer at 205°F.')
    expect(localizeText('Simmer at 350°F.', 'metric')).toBe('Simmer at 177°C.')
  })

  test('a parenthetical stating a DIFFERENT temperature converts independently, never dropped', () => {
    // 220°C is 428°F; 400°F is 204°C — 16° apart, far outside tolerance.
    expect(localizeText('Roast at 220°C (400°F).', 'metric')).toBe('Roast at 220°C (204°C).')
    expect(localizeText('Roast at 220°C (400°F).', 'imperial')).toBe('Roast at 428°F (400°F).')
  })

  test('prose with no temperature is bit-for-bit unchanged in BOTH systems', () => {
    const step = 'Whisk the eggs, then fold in the flour until just combined.'
    expect(localizeText(step, 'metric')).toBe(step)
    expect(localizeText(step, 'imperial')).toBe(step)
    expect(localizeText('', 'imperial')).toBe('')
  })

  test('the localization is idempotent: localizing twice changes nothing', () => {
    for (const system of UNIT_SYSTEMS) {
      const once = localizeText('Preheat oven to 220°C (425°F) and rest 10 minutes.', system)
      expect(localizeText(once, system)).toBe(once)
    }
  })
})

describe('lengths in prose and annotations (ADR-0047 §4)', () => {
  test('cm ↔ inch, with formatAmount precision', () => {
    expect(localizeText('Cut the carrot into 5 cm pieces.', 'imperial')).toBe(
      'Cut the carrot into 2 inches pieces.',
    )
    expect(localizeText('Cut the carrot into 1 inch pieces.', 'metric')).toBe(
      'Cut the carrot into 2.5 cm pieces.',
    )
  })

  test('fractional lengths convert too', () => {
    // formatAmount's 1-decimal grammar: 2.5 cm is 0.98 inch → "1 inch".
    expect(localizeText('Cut into 2 ½ cm pieces.', 'imperial')).toBe('Cut into 1 inch pieces.')
  })

  test('metric length prose is untouched', () => {
    const step = 'Cut the carrot into 5 cm pieces.'
    expect(localizeText(step, 'metric')).toBe(step)
  })

  test('a HYPHENATED length converts in both systems (408 corpus occurrences)', () => {
    expect(localizeText('Cut into 3-inch pieces.', 'metric')).toBe('Cut into 7.6 cm pieces.')
    expect(localizeText('Slice 1 ¼-cm thick wedges.', 'imperial')).toBe(
      'Slice 0.5 inch thick wedges.',
    )
    // Already imperial: the authored string is the target system, kept verbatim.
    expect(localizeText('Cut into 3-inch pieces.', 'imperial')).toBe('Cut into 3-inch pieces.')
  })

  test('`<number> in` is PROSE, never a length — in either system', () => {
    // The corpus writes lengths in full (`inch`/`inches`); 0 occurrences of
    // `<number> in` across 2,759 docs, so the abbreviation bought nothing and
    // cost ordinary English (`cut 2 in half` → `cut 5.1 cm half`).
    for (const step of ['Cut the chicken in half.', 'Cook the 3 in batches.']) {
      expect(localizeText(step, 'metric')).toBe(step)
      expect(localizeText(step, 'imperial')).toBe(step)
    }
  })

  test('a temperature RANGE converts both bounds, in either system', () => {
    expect(localizeText('Bake at 180-200°C until golden.', 'imperial')).toBe(
      'Bake at 356-392°F until golden.',
    )
    expect(localizeText('Roast at 350 to 375°F.', 'metric')).toBe('Roast at 177 to 191°C.')
    // The source system is already the target: nothing to do.
    expect(localizeText('Bake at 180-200°C.', 'metric')).toBe('Bake at 180-200°C.')
    // A degree-less range is a duration/count, never a temperature.
    expect(localizeText('Bake for 20-25 minutes.', 'imperial')).toBe('Bake for 20-25 minutes.')
  })

  test('a RANGE whose low bound is not a temperature stays PROSE', () => {
    // Prose pairs a lone small number with a real temperature exactly the way
    // a range does, and the shared degree sign is on the SECOND number only.
    // The low bound is a step / a count, so the range must be rejected whole:
    // only the genuine temperature converts, and the prose `2 to` is intact.
    expect(localizeText('Cook 2 to 350°F.', 'metric')).toBe('Cook 2 to 177°C.')
    expect(localizeText('At step 3 - 200°C rest the chicken.', 'imperial')).toBe(
      'At step 3 - 392°F rest the chicken.',
    )
    // Same string, target system already written: nothing to convert.
    expect(localizeText('Cook 2 to 350°F.', 'imperial')).toBe('Cook 2 to 350°F.')
    // The floor is a temperature floor, not a digit-count rule: a genuine low
    // end (65 °C, the slowest setpoint in the catalog) still converts, in
    // either system.
    expect(localizeText('Hold at 65-70°C.', 'imperial')).toBe('Hold at 149-158°F.')
    // Descending bounds are prose order, not a range. Rejecting it is still
    // right even though the result looks odd: the lone `350°F` is a real
    // temperature, so the token pass below converts that one and nothing
    // pretends `375` is part of it.
    expect(localizeText('Stir 375-350°F at most.', 'metric')).toBe('Stir 375-177°C at most.')
  })
})

describe('quantities (ADR-0047 §1)', () => {
  test('mass: kg → lb and g → oz', () => {
    expect(localizeQuantity('450 g', 'imperial')).toBe('15.9 oz')
    expect(localizeQuantity('1.5 kg', 'imperial')).toBe('3.3 lb')
    expect(localizeQuantity('0.5 kg', 'imperial')).toBe('1.1 lb')
  })

  test('volume: ml → fl oz', () => {
    expect(localizeQuantity('250 ml', 'imperial')).toBe('8.5 fl oz')
    expect(localizeQuantity('398 ml', 'imperial')).toBe('13.5 fl oz')
  })

  test('a container quantity converts its ANNOTATION and keeps the count and noun', () => {
    expect(localizeQuantity('1 (142 g) pkg', 'imperial')).toBe('1 (5 oz) pkg')
    expect(localizeQuantity('1.5 (142 g) pkg', 'imperial')).toBe('1.5 (5 oz) pkg')
    expect(localizeQuantity('3 (2 ½ cm) pieces', 'imperial')).toBe('3 (1 inch) pieces')
  })

  test('a container head keeps the authored FRACTION, not a flattened decimal', () => {
    // formatContainerQuantity renders ADR-0017 sums as fractions (`½`,
    // `1 ½`). `parseQuantity` throws the fraction away (it is summed as a
    // float), so the head must be sliced back out of the raw string rather
    // than re-formatted: `0.5 (5 oz) pkg` would misread as a decimal.
    expect(localizeQuantity('½ (142 g) pkg', 'imperial')).toBe('½ (5 oz) pkg')
    expect(localizeQuantity('1 ½ (142 g) pkg', 'imperial')).toBe('1 ½ (5 oz) pkg')
    expect(localizeQuantity('3/4 (142 g) pkg', 'imperial')).toBe('3/4 (5 oz) pkg')
    expect(localizeQuantity('½ (142 g) small bunch', 'imperial')).toBe('½ (5 oz) small bunch')
  })

  test('imperial-native and count units pass through in BOTH systems', () => {
    // `cup` is NOT in this list: a cup is a purchasable volume container and
    // gains an annotation in the two single-system modes (see the cups block).
    for (const q of ['3 tbsp', '6 cloves', '1 small bunch', '1 head', '3 (3 oz) cans']) {
      expect(localizeQuantity(q, 'dual')).toBe(q)
      expect(localizeQuantity(q, 'metric')).toBe(q)
      expect(localizeQuantity(q, 'imperial')).toBe(q)
    }
  })

  test('an authored oz straggler stays oz in imperial (ADR-0047 table)', () => {
    expect(localizeQuantity('3 (3 oz) pkg', 'imperial')).toBe('3 (3 oz) pkg')
  })

  test('free-form text with no leading amount is never re-authored', () => {
    expect(localizeQuantity('a pinch', 'imperial')).toBe('a pinch')
    expect(localizeQuantity('', 'imperial')).toBe('')
    expect(localizeQuantity('to taste', 'imperial')).toBe('to taste')
  })

  test('a bare count with no unit keeps its value', () => {
    expect(localizeQuantity('3', 'imperial')).toBe('3')
  })
})

describe('scaled steps (one shared helper, ADR-0047 §4)', () => {
  const steps = [
    { primary: 'Preheat oven to 220°C (425°F).', details: ['Chop 450 g of beef.'], concurrent: false },
    { primary: 'Meanwhile, preheat oven to 450°F (232°C).', details: [], concurrent: true },
  ]

  test('imperial converts primary and detail text', () => {
    expect(localizeSteps(steps, 'imperial')).toEqual([
      {
        primary: 'Preheat oven to 425°F.',
        details: ['Chop 450 g of beef.'],
        concurrent: false,
      },
      { primary: 'Meanwhile, preheat oven to 450°F.', details: [], concurrent: true },
    ])
  })

  test('metric collapses the dual notation too — the catalog reads badly in BOTH systems', () => {
    expect(localizeSteps(steps, 'metric')).toEqual([
      {
        primary: 'Preheat oven to 220°C.',
        // A detail line's authored MASS is prose, not a quantity: the
        // ingredient list and the grocery list are the converted surfaces.
        details: ['Chop 450 g of beef.'],
        concurrent: false,
      },
      { primary: 'Meanwhile, preheat oven to 232°C.', details: [], concurrent: true },
    ])
  })

  test('a step with no temperature and no length is the authored string, in BOTH systems', () => {
    const plain = [{ primary: 'Fold in the flour until just combined.', details: ['Serve warm.'], concurrent: false }]
    expect(localizeSteps(plain, 'metric')).toEqual(plain)
    expect(localizeSteps(plain, 'imperial')).toEqual(plain)
  })

  test('structural: unrelated members survive the spread', () => {
    const out = localizeSteps([{ primary: '450°F', details: [], concurrent: false }], 'imperial')
    expect(out[0].concurrent).toBe(false)
  })
})
