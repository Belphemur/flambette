import { describe, expect, test } from 'bun:test'
import { parseChangelog } from './changelog'

const BASE = { generatedAt: '2026-10-07T00:00:00Z', versions: [] as any[] }

function doc(overrides: { versions: any[] }) {
  return { ...BASE, ...overrides }
}

describe('parseChangelog', () => {
  test('null input returns null', () => {
    expect(parseChangelog(null)).toBeNull()
  })

  test('non-object input returns null', () => {
    expect(parseChangelog('string')).toBeNull()
    expect(parseChangelog(42)).toBeNull()
    expect(parseChangelog(undefined)).toBeNull()
  })

  test('empty versions array returns null', () => {
    expect(parseChangelog({ ...BASE, versions: [] })).toBeNull()
  })

  test('versions is not an array returns null', () => {
    expect(parseChangelog({ ...BASE, versions: 'oops' })).toBeNull()
  })

  test('version with no valid entries returns null', () => {
    expect(
      parseChangelog({
        ...BASE,
        versions: [{ version: 'not-a-version', date: '', title: '' }],
      }),
    ).toBeNull()
  })

  test('valid versions are normalized', () => {
    const result = parseChangelog(
      doc({
        versions: [
          {
            version: 'v1.0.0',
            date: '2026-01-01',
            title: 'First release',
            features: [
              { text: 'Add groceries', scope: 'grocery', pr: 1, adr: 'ADR-0001' },
              { text: 'A plain feat', scope: null, pr: null, adr: null },
            ],
            fixes: [{ text: 'Fix crash', scope: 'core', pr: 2, adr: null }],
          },
        ],
      }),
    )
    expect(result).not.toBeNull()
    expect(result!.versions).toHaveLength(1)
    const v = result!.versions[0]
    expect(v.version).toBe('v1.0.0')
    expect(v.date).toBe('2026-01-01')
    expect(v.title).toBe('First release')
    expect(v.features).toHaveLength(2)
    expect(v.features[0]).toEqual({
      text: 'Add groceries',
      scope: 'grocery',
      pr: 1,
      adr: 'ADR-0001',
    })
    expect(v.features[1]).toEqual({
      text: 'A plain feat',
      scope: null,
      pr: null,
      adr: null,
    })
    expect(v.fixes).toHaveLength(1)
    expect(v.fixes[0]).toEqual({
      text: 'Fix crash',
      scope: 'core',
      pr: 2,
      adr: null,
    })
  })

  test('wrong types in entries are dropped', () => {
    const result = parseChangelog(
      doc({
        versions: [
          {
            version: 'v1.0.0',
            date: '2026-01-01',
            title: 'T',
            features: [
              null,
              'not an object',
              { text: 42 }, // text not a string → entry dropped
              { text: 'ok', pr: 'not-a-number', adr: 123 },
            ],
          },
        ],
      }),
    )
    expect(result!.versions[0].features).toHaveLength(1)
    expect(result!.versions[0].features[0]).toEqual({
      text: 'ok',
      scope: null,
      pr: null,
      adr: null,
    })
  })

  test('versions are sorted newest first', () => {
    const result = parseChangelog(
      doc({
        versions: [
          { version: 'v0.1.0', date: '', title: 'old', features: [], fixes: [] },
          { version: 'v2.0.0', date: '', title: 'new', features: [], fixes: [] },
          { version: 'v1.0.0', date: '', title: 'mid', features: [], fixes: [] },
        ],
      }),
    )
    expect(result!.versions.map((v) => v.version)).toEqual(['v2.0.0', 'v1.0.0', 'v0.1.0'])
  })

  test('missing title falls back to version string', () => {
    const result = parseChangelog(
      doc({
        versions: [{ version: 'v1.0.0', date: '', title: null, features: [], fixes: [] }],
      }),
    )
    expect(result!.versions[0].title).toBe('v1.0.0')
  })

  test('generatedAt missing defaults to empty string', () => {
    const result = parseChangelog({ versions: [{ version: 'v1.0.0', date: 'd', title: 't', features: [], fixes: [] }] })
    expect(result!.generatedAt).toBe('')
  })

  test('feature without text is dropped, feature with text but empty scope is kept', () => {
    const result = parseChangelog(
      doc({
        versions: [
          {
            version: 'v1.0.0',
            date: '',
            title: 't',
            features: [
              { text: '' }, // empty text → dropped
              { text: 'real' }, // no scope → null
            ],
            fixes: [],
          },
        ],
      }),
    )
    expect(result!.versions[0].features).toHaveLength(1)
    expect(result!.versions[0].features[0].text).toBe('real')
    expect(result!.versions[0].features[0].scope).toBeNull()
  })
})
