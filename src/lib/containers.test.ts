import { describe, expect, test } from 'bun:test'
import {
  containerContribution,
  containerKey,
  formatContainerQuantity,
  parseContainerQuantity,
} from './containers'
import { formatFraction } from './quantity'

describe('parseContainerQuantity', () => {
  test('splits count, annotation and container', () => {
    expect(parseContainerQuantity('½ (142 g) pkg')).toEqual({
      count: 0.5,
      container: 'pkg',
      annotation: '(142 g)',
      raw: '½ (142 g) pkg',
    })
  })

  test('handles adjectives, plurals and inner-space annotations', () => {
    expect(parseContainerQuantity('2 ½ cm pieces')).toBeNull()
    expect(parseContainerQuantity('½ small bunches')?.container).toBe('small bunches')
    expect(parseContainerQuantity('½ (227g ) pkgs')?.annotation).toBe('(227g )')
    expect(parseContainerQuantity('¾ (227 g) block')?.count).toBe(0.75)
    expect(parseContainerQuantity('1 head')?.container).toBe('head')
  })

  test('rejects spoon measures and count units', () => {
    for (const raw of [
      '2 cups',
      '1 tbsp',
      '710 ml',
      '15 g',
      '3 cloves',
      '2 slices',
      '2 ½ cm pieces',
      '1 medium',
      'to taste',
      '',
    ]) {
      expect(parseContainerQuantity(raw)).toBeNull()
    }
  })
})

describe('containerKey', () => {
  test('merges across plural spellings, splits on annotation', () => {
    expect(containerKey('pkg', '(142 g)')).toBe(containerKey('pkgs', '(142 g)'))
    expect(containerKey('pkg', '(142 g)')).not.toBe(containerKey('pkg', '(113 g)'))
  })
})

describe('containerContribution', () => {
  test('keeps the authored count at 1x and ceils when scaled up', () => {
    expect(containerContribution(0.5, 1)).toBe(0.5)
    expect(containerContribution(0.5, 2)).toBe(1)
    expect(containerContribution(1, 2)).toBe(2)
    expect(containerContribution(0.75, 3)).toBe(3)
    // A container ingredient never drops below one purchasable container.
    expect(containerContribution(0.25, 2)).toBe(1)
  })
})

describe('formatContainerQuantity', () => {
  test('integers, plurals and preserved annotations', () => {
    expect(formatContainerQuantity(1, 'pkg', '(142 g)')).toBe('1 (142 g) pkg')
    expect(formatContainerQuantity(2, 'pkg', '(142 g)')).toBe('2 (142 g) pkgs')
    expect(formatContainerQuantity(1, 'small bunch', '')).toBe('1 small bunch')
    expect(formatContainerQuantity(1, 'boxes', '')).toBe('1 box')
  })

  test('fractional remainders from multi-recipe sums', () => {
    expect(formatContainerQuantity(1.5, 'small bunches', '')).toBe('1 ½ small bunches')
    expect(formatContainerQuantity(0.5, 'block', '(227 g)')).toBe('½ (227 g) blocks')
  })
})

describe('formatFraction', () => {
  test('whole, mixed and simple fractions', () => {
    expect(formatFraction(1)).toBe('1')
    expect(formatFraction(0.5)).toBe('½')
    expect(formatFraction(1.5)).toBe('1 ½')
    expect(formatFraction(0.75)).toBe('¾')
    expect(formatFraction(0.375)).toBe('⅜')
    expect(formatFraction(2 / 3)).toBe('⅔')
    expect(formatFraction(7.25)).toBe('7 ¼')
  })

  test('falls back to 1 decimal for non-repeating fractions', () => {
    expect(formatFraction(1.7)).toBe('1.7')
  })
})
