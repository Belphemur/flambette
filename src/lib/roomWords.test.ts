import { describe, expect, test } from 'bun:test'
import {
  ANIMAL_WORDS,
  COLOR_WORDS,
  LEGACY_ROOM_CODE_RE,
  NAME_ADJECTIVES,
  NAME_NOUNS,
  PLACE_WORDS,
  WORD_ROOM_CODE_RE,
  formatRoomCode,
  generateDisplayName,
  generateRoomCode,
  isRoomCode,
  isWordRoomCode,
  normalizeRoomCode,
  titleCaseName,
  wordListProblem,
} from './roomWords'

describe('word lists', () => {
  test('each list has 64+ curated lowercase ASCII words of 3–10 letters', () => {
    for (const list of [COLOR_WORDS, ANIMAL_WORDS, PLACE_WORDS]) {
      expect(wordListProblem(list)).toBeNull()
    }
  })

  test('lists are disjoint enough that a code is readable', () => {
    expect(new Set(COLOR_WORDS).size).toBe(COLOR_WORDS.length)
    expect(new Set(ANIMAL_WORDS).size).toBe(ANIMAL_WORDS.length)
    expect(new Set(PLACE_WORDS).size).toBe(PLACE_WORDS.length)
  })
})

describe('generateRoomCode', () => {
  test('produces the canonical three-word shape', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateRoomCode()
      expect(code).toMatch(WORD_ROOM_CODE_RE)
      const [c, a, p] = code.split('-')
      expect(COLOR_WORDS).toContain(c)
      expect(ANIMAL_WORDS).toContain(a)
      expect(PLACE_WORDS).toContain(p)
    }
  })

  test('the space is large (64³ ≈ 262k) and rolls are not all identical', () => {
    expect(COLOR_WORDS.length * ANIMAL_WORDS.length * PLACE_WORDS.length).toBeGreaterThan(262_000)
    const rolls = new Set(Array.from({ length: 50 }, generateRoomCode))
    expect(rolls.size).toBeGreaterThan(40)
  })
})

describe('formatRoomCode', () => {
  test('lowercases and hyphenates regardless of the caller separators', () => {
    expect(formatRoomCode(['Amber', ' Falcon ', 'Lantern'])).toBe('amber-falcon-lantern')
  })
})

describe('normalizeRoomCode', () => {
  test('accepts hyphens, spaces, underscores or nothing at all', () => {
    for (const raw of [
      'amber-falcon-lantern',
      'Amber-Falcon-Lantern',
      'amber falcon lantern',
      'amber_falcon_lantern',
      'amberfalconlantern',
      '  Amber   Falcon-Lantern  ',
    ]) {
      expect(normalizeRoomCode(raw)).toBe('amber-falcon-lantern')
    }
  })

  test('legacy alphanumeric codes still normalize to upper case', () => {
    expect(normalizeRoomCode('ZZ9ZZZ')).toBe('ZZ9ZZZ')
    expect(normalizeRoomCode('zz9zzz')).toBe('ZZ9ZZZ')
    expect(normalizeRoomCode(' ab12 ')).toBe('AB12')
  })

  test('rejects junk rather than coercing it', () => {
    for (const raw of ['', '   ', 'a', 'amber-falcon', 'amber falcon lantern extra', '!!']) {
      expect(normalizeRoomCode(raw)).toBe('')
    }
  })

  test('a word token containing digits is rejected, not coerced to legacy', () => {
    // "amber1-falcon2-lantern3" is neither shape; joining the wrong room is
    // worse than refusing the input.
    expect(normalizeRoomCode('amber1-falcon2-lantern3')).toBe('')
  })
  test('a run-together token is split back into three words', () => {
    expect(normalizeRoomCode('amberfalconlantern')).toBe('amber-falcon-lantern')
    // A purely alphabetic legacy-ish token stays legacy (no valid 3-way
    // split exists for a 7-letter token).
    expect(normalizeRoomCode('kitchen')).toBe('KITCHEN')
  })
})

describe('isRoomCode', () => {
  test('accepts the union of both formats', () => {
    expect(isRoomCode('amber-falcon-lantern')).toBe(true)
    expect(isRoomCode('ZZ9ZZZ')).toBe(true)
    expect(isRoomCode('amber falcon')).toBe(false)
    expect(isRoomCode('TOOLONGCODE12345')).toBe(false)
  })

  test('the two regexes do not overlap', () => {
    expect(isWordRoomCode('amber-falcon-lantern')).toBe(true)
    expect(isWordRoomCode('ZZ9ZZZ')).toBe(false)
    expect(LEGACY_ROOM_CODE_RE.test('ZZ9ZZZ')).toBe(true)
  })
})

describe('display-name lists (ADR-0063)', () => {
  test('each name list passes the same curated invariants as the code lists', () => {
    for (const list of [NAME_ADJECTIVES, NAME_NOUNS]) {
      expect(wordListProblem(list)).toBeNull()
    }
  })

  test('name lists are DISJOINT from the room-code lists', () => {
    // A name never reads like a room code, so its words must never be
    // room-code words.
    const codeWords = new Set([...COLOR_WORDS, ...ANIMAL_WORDS, ...PLACE_WORDS])
    for (const list of [NAME_ADJECTIVES, NAME_NOUNS]) {
      const overlap = list.filter((word) => codeWords.has(word))
      expect(overlap).toEqual([])
    }
  })

  test('generated names are Title Case "Adjective Noun" pairs', () => {
    for (let i = 0; i < 100; i++) {
      const name = generateDisplayName()
      expect(name).toMatch(/^[A-Z][a-z]{2,9} [A-Z][a-z]{2,9}$/)
      const [adj, noun] = name.toLowerCase().split(' ')
      expect(NAME_ADJECTIVES).toContain(adj)
      expect(NAME_NOUNS).toContain(noun)
    }
  })

  test('titleCaseName title-cases a hyphenated pair', () => {
    expect(titleCaseName('brave otter')).toBe('Brave Otter')
    expect(titleCaseName('BRAVE OTTER')).toBe('Brave Otter')
    expect(titleCaseName('  brave   otter ')).toBe('Brave Otter')
  })
})
