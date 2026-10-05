import { describe, expect, test } from 'bun:test'
import { humanizeAmount, humanizeScaledQuantity } from './quantity'

/**
 * ADR-0054's display rule for SCALED quantities: the authored text stays
 * exact; a scaled rendering rounds the way a cook reads it — counts round
 * half-DOWN to whole pieces, mass/volume lose their sub-integer noise from
 * 5 units up, spoons keep the fraction. Pinned here as pure unit tests so
 * the recipe page and the cooking view can never drift apart on it.
 */
describe('humanizeAmount (scaled-quantity display rounding)', () => {
  test('counts round half-down to whole pieces', () => {
    expect(humanizeAmount(2.25, 'large eggs')).toBe('2')
    expect(humanizeAmount(2.5, 'eggs')).toBe('2')
    expect(humanizeAmount(2.75, 'large eggs')).toBe('3')
    expect(humanizeAmount(3, 'large eggs')).toBe('3')
    expect(humanizeAmount(1.5, 'cloves')).toBe('1')
  })

  test('mass/volume lose sub-integer noise from 5 up', () => {
    expect(humanizeAmount(26.25, 'g')).toBe('26')
    expect(humanizeAmount(26.3, 'g')).toBe('26')
    expect(humanizeAmount(37.5, 'g')).toBe('37')
    expect(humanizeAmount(7.5, 'ml')).toBe('7')
    expect(humanizeAmount(375, 'ml')).toBe('375')
    expect(humanizeAmount(90, 'g')).toBe('90')
  })

  test('small mass/volume amounts keep their decimal', () => {
    // Under 5 the fraction is real information: baking powder, spices.
    expect(humanizeAmount(2.3, 'g')).toBe('2.3')
    expect(humanizeAmount(3.5, 'g')).toBe('3.5')
    expect(humanizeAmount(4.9, 'ml')).toBe('4.9')
  })

  test('spoon units keep the fraction', () => {
    expect(humanizeAmount(1.75, 'tsp')).toBe('1.8')
    expect(humanizeAmount(2.5, 'tbsp')).toBe('2.5')
  })
})

describe('humanizeScaledQuantity (the string form)', () => {
  test('routes a scaled string through the same rule, unit preserved', () => {
    expect(humanizeScaledQuantity('2.25 large eggs')).toBe('2 large eggs')
    expect(humanizeScaledQuantity('26.25 g')).toBe('26 g')
    expect(humanizeScaledQuantity('30 ml')).toBe('30 ml')
    expect(humanizeScaledQuantity('2.3 g')).toBe('2.3 g')
  })

  test('an unparseable string passes through verbatim', () => {
    expect(humanizeScaledQuantity('to taste')).toBe('to taste')
    expect(humanizeScaledQuantity('')).toBe('')
  })

  test('whole values are unchanged strings of themselves', () => {
    expect(humanizeScaledQuantity('3 large eggs')).toBe('3 large eggs')
    expect(humanizeScaledQuantity('40 ml')).toBe('40 ml')
    expect(humanizeScaledQuantity('6')).toBe('6')
  })
})
