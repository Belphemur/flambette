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
  test('metric is the default and the only two accepted systems are metric/imperial', () => {
    expect(UNIT_SYSTEMS).toEqual(['metric', 'imperial'])
    expect(DEFAULT_UNIT_SYSTEM).toBe('metric')
  })

  test('isUnitSystem accepts the two systems and refuses everything else', () => {
    expect(isUnitSystem('metric')).toBe(true)
    expect(isUnitSystem('imperial')).toBe(true)
    for (const bad of ['', 'Metric', 'IMPERIAL', 'cups', null, undefined, 0, 1, {}, []]) {
      expect(isUnitSystem(bad)).toBe(false)
    }
  })

  test('metric quantities are the IDENTITY — no rounding churn on any authored line', () => {
    for (const q of ['450 g', '1.5 kg', '250 ml', '½ (142 g) pkg', '1 (142 g) pkg', '3 (2 ½ cm) pieces', '2 cups', '3 tbsp', '6 cloves', '', 'a pinch']) {
      expect(localizeQuantity(q, 'metric')).toBe(q)
      expect(localizeLine(q, 'metric')).toBe(q)
    }
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

  test('imperial-native and count units pass through in BOTH systems', () => {
    for (const q of ['2 cups', '3 tbsp', '6 cloves', '1 small bunch', '1 head', '3 (3 oz) cans']) {
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

  test('metric is the same array object — the unscaled authoring path is untouched', () => {
    expect(localizeSteps(steps, 'metric')).toBe(steps)
  })

  test('structural: unrelated members survive the spread', () => {
    const out = localizeSteps([{ primary: '450°F', details: [], concurrent: false }], 'imperial')
    expect(out[0].concurrent).toBe(false)
  })
})
