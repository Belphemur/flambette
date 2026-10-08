import { describe, expect, test } from 'bun:test'
import {
  GUEST_NAME,
  MAX_NAME_CHARS,
  isUuidShape,
  sanitizeDisplayName,
} from './profileName'

describe('sanitizeDisplayName', () => {
  test('trims surrounding whitespace and collapses runs', () => {
    expect(sanitizeDisplayName('  Brave   Otter  ')).toBe('Brave Otter')
    expect(sanitizeDisplayName('Brave\tOtter\n')).toBe('Brave Otter')
  })

  test('strips control and format characters', () => {
    // BEL + zero-width joiner + bidi isolate: all Unicode category C.
    expect(sanitizeDisplayName('Bra\u0007ve\u200d Ot\u202eter')).toBe('Brave Otter')
  })

  test('caps at 40 visible characters (code points)', () => {
    const long = 'a'.repeat(80)
    expect([...sanitizeDisplayName(long)]).toHaveLength(MAX_NAME_CHARS)
    // Multi-unit graphemes count as their code points.
    const family = '🏴'.repeat(20)
    expect([...sanitizeDisplayName(family)]).toHaveLength(20)
  })

  test('returns empty for non-strings and blank input', () => {
    expect(sanitizeDisplayName(undefined)).toBe('')
    expect(sanitizeDisplayName(42)).toBe('')
    expect(sanitizeDisplayName('   ')).toBe('')
    expect(sanitizeDisplayName('\u0007\u200d')).toBe('')
  })
})

describe('isUuidShape', () => {
  test('accepts canonical UUIDs (v7 and other versions)', () => {
    expect(isUuidShape('018f1a2b-3c4d-7e8f-9a0b-1c2d3e4f5a6b')).toBe(true)
    expect(isUuidShape('123e4567-e89b-12d3-a456-426614174000')).toBe(true)
    expect(isUuidShape('018F1A2B-3C4D-7E8F-9A0B-1C2D3E4F5A6B')).toBe(true)
  })

  test('rejects non-UUIDs', () => {
    expect(isUuidShape('')).toBe(false)
    expect(isUuidShape('guest')).toBe(false)
    expect(isUuidShape('018f1a2b-3c4d-7e8f-9a0b-1c2d3e4f5a6')).toBe(false)
    expect(isUuidShape(null)).toBe(false)
    expect(isUuidShape(42)).toBe(false)
  })
})

describe('constants', () => {
  test('Guest is the profile-less row name and the cap is the relay cap', () => {
    expect(GUEST_NAME).toBe('Guest')
    expect(MAX_NAME_CHARS).toBe(40)
  })
})
