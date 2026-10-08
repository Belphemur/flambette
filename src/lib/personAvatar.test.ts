import { describe, expect, test } from 'bun:test'
import {
  AVATAR_TONE_PREFIXES,
  avatarTones,
  extractAvatarTones,
  type ComputedStyleLike,
} from './personAvatar'
import { hashToSeeds } from 'hashvatar'

/**
 * The avatar palette bridge (ADR-0063): tones are read from CSS custom
 * properties at runtime (stubbed here), and the generator's hash → seeds
 * contract is deterministic.
 */

/** A computed style stub: declaration list + getPropertyValue. */
function styleOf(decls: Record<string, string>): ComputedStyleLike {
  return {
    getPropertyValue: (name) => decls[name] ?? '',
    *[Symbol.iterator]() {
      yield* Object.keys(decls)
    },
  }
}

describe('extractAvatarTones', () => {
  test('collects values from the three avatar families, in declaration order', () => {
    const style = styleOf({
      '--color-hue-meat': '#b3381f',
      '--color-hue-fish-soft': '#5cc0d8',
      '--color-meal-dessert': '#a81e6b',
      '--color-nutrition-sodium': '#4f46e5',
      // A family the avatars must IGNORE (semantic UI colour).
      '--color-success': '#0000ff',
      // An unrelated custom property.
      '--spacing-4': '1rem',
    })
    expect(extractAvatarTones(style)).toEqual([
      '#b3381f',
      '#5cc0d8',
      '#a81e6b',
      '#4f46e5',
    ])
  })

  test('dedupes by VALUE across families', () => {
    const style = styleOf({
      '--color-hue-fish': '#0e7490',
      '--color-nutrition-carbs': '#0e7490',
      '--color-hue-meat': '#b3381f',
    })
    expect(extractAvatarTones(style)).toEqual(['#0e7490', '#b3381f'])
  })

  test('skips empty values', () => {
    const style = styleOf({
      '--color-hue-meat': '',
      '--color-meal-lunch': '   ',
      '--color-hue-vegan': '#047857',
    })
    expect(extractAvatarTones(style)).toEqual(['#047857'])
  })

  test('the dark flip is just another value set — same names, other tones', () => {
    const light = styleOf({ '--color-hue-meat': '#b3381f' })
    const dark = styleOf({ '--color-hue-meat': '#f08a6a' })
    expect(extractAvatarTones(light)).toEqual(['#b3381f'])
    expect(extractAvatarTones(dark)).toEqual(['#f08a6a'])
  })
})

describe('avatarTones (runtime wrapper)', () => {
  test('returns [] without a DOM, so the generator keeps its own palette', () => {
    // bun test has no window/document.
    expect(AVATAR_TONE_PREFIXES).toContain('--color-hue-')
    expect(avatarTones()).toEqual([])
  })
})

describe('hash → seeds (the generator contract PersonAvatar relies on)', () => {
  test('the same name always produces the same seeds', () => {
    const a = hashToSeeds('Brave Otter', 4)
    const b = hashToSeeds('Brave Otter', 4)
    expect(a).toEqual(b)
    expect(a).toHaveLength(4)
  })

  test('different names produce (with practical certainty) different seeds', () => {
    expect(hashToSeeds('Brave Otter', 4)).not.toEqual(hashToSeeds('Calm Ferret', 4))
  })

  test('a rename re-skins the pattern (the seed list follows the name)', () => {
    const before = hashToSeeds('Brave Otter', 4)
    const after = hashToSeeds('Swift Marmot', 4)
    expect(before).not.toEqual(after)
  })
})
