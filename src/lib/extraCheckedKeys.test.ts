import { describe, expect, test } from 'bun:test'
import {
  EXTRA_KEY_PREFIX,
  LEGACY_EXTRA_KEY_PREFIX,
  extraCheckedKey,
  reconcileCheckedExtras,
} from './extraCheckedKeys'

/**
 * An extra's checkbox key is DERIVED from its name, so the key and the extra
 * it describes are two facts that must agree — and nothing else enforces it.
 * `plan.customItems` and the checked map travel as SEPARATE payload fields
 * (room snapshot, backup archive, share link), so any peer at any app
 * version can hand us a key with no matching extra.
 *
 * When that happens the residue is invisible but harmful: the key reads as
 * "already done", so re-adding that name lands in a sub-section the
 * done-map immediately calls COMPLETE, and ADR-0050's uniform auto-collapse
 * hides the row the user just added. These cases pin the reconciler that
 * removes it.
 */
describe('extraCheckedKey', () => {
  test('is the lowercased prefixed form, so two casings of a name collide', () => {
    expect(extraCheckedKey('Banana')).toBe(`${EXTRA_KEY_PREFIX}banana`)
    expect(extraCheckedKey('banana')).toBe(`${EXTRA_KEY_PREFIX}banana`)
  })

  test('uses a delimiter a grocery LINE key can never contain', () => {
    // Line keys are `${nameKey}||${display}` (src/lib/grocery.ts). An extras
    // prefix of `custom||` was indistinguishable from a line key whose
    // ingredient normalizes to exactly "custom"; `::` cannot appear in a
    // nameKey, so the two key spaces are disjoint BY CONSTRUCTION.
    expect(EXTRA_KEY_PREFIX).not.toContain('||')
    expect(extraCheckedKey('kale')).not.toContain('||')
  })
})

describe('reconcileCheckedExtras', () => {
  test('drops a key whose extra is gone', () => {
    const { map, changed } = reconcileCheckedExtras({ [`${EXTRA_KEY_PREFIX}ghost`]: true }, ['kale'])
    expect(map).toEqual({})
    expect(changed).toBe(true)
  })

  test('keeps a key whose extra is still present', () => {
    const key = extraCheckedKey('kale')
    const { map, changed } = reconcileCheckedExtras({ [key]: true }, ['kale'])
    expect(map).toEqual({ [key]: true })
    expect(changed).toBe(false)
  })

  test('matches the extra case-insensitively (the key is lowercased on both sides)', () => {
    const { map, changed } = reconcileCheckedExtras({ [`${EXTRA_KEY_PREFIX}kale`]: true }, ['KALE'])
    expect(map).toEqual({ [`${EXTRA_KEY_PREFIX}kale`]: true })
    expect(changed).toBe(false)
  })

  test('never touches recipe-derived line keys, even when no extras exist', () => {
    // A grocery line key's lifecycle belongs to the PLAN, not the extras:
    // `checked.json` and a room snapshot both carry these, and they must
    // survive untouched or the list silently un-checks itself mid-shop.
    const checked = {
      [`${EXTRA_KEY_PREFIX}ghost`]: true,
      '12345||tomato': true,
      '12345||onion': true,
      '12345||raw||6 medium': true,
    }
    const { map } = reconcileCheckedExtras(checked, [])
    expect(map).toEqual({
      '12345||tomato': true,
      '12345||onion': true,
      '12345||raw||6 medium': true,
    })
  })

  test('a LEGACY-prefix line key whose ingredient normalizes to "custom" survives', () => {
    // The regression kody-ai flagged: a line key for an ingredient named
    // "custom" has the shape `custom||<display>`, which is exactly a legacy
    // extras key. It is split structurally — a further `||` in the segment
    // means it is a LINE key — so it must never be dropped.
    const lineKey = 'custom||6 medium carrots'
    const { map, changed } = reconcileCheckedExtras({ [lineKey]: true }, [])
    expect(map).toEqual({ [lineKey]: true })
    expect(changed).toBe(false)
  })

  test('a false-valued extras key is dropped too (it is still residue)', () => {
    const { map, changed } = reconcileCheckedExtras({ [`${EXTRA_KEY_PREFIX}ghost`]: false }, [])
    expect(map).toEqual({})
    expect(changed).toBe(true)
  })

  test('is a no-op when everything agrees — returns the SAME object', () => {
    const checked = { [extraCheckedKey('kale')]: true }
    const { map, changed } = reconcileCheckedExtras(checked, ['kale'])
    expect(changed).toBe(false)
    // Referential identity is what lets a caller skip a no-op store write
    // (and, in applyRemote, avoid an unnecessary republish).
    expect(map).toBe(checked as Record<string, boolean>)
  })

  test('handles an empty checked map, empty extras, and non-extras keys', () => {
    expect(reconcileCheckedExtras({}, ['kale'])).toEqual({ map: {}, changed: false })
    // `a` is not an extras key, so it survives untouched.
    expect(reconcileCheckedExtras({ a: true }, [])).toEqual({ map: { a: true }, changed: false })
  })

  test('drops only the orphans, keeping every live extra checked', () => {
    const { map } = reconcileCheckedExtras(
      {
        [`${EXTRA_KEY_PREFIX}kale`]: true,
        [`${EXTRA_KEY_PREFIX}apple`]: true,
        [`${EXTRA_KEY_PREFIX}ghost`]: true,
      },
      ['kale', 'apple'],
    )
    expect(map).toEqual({
      [`${EXTRA_KEY_PREFIX}kale`]: true,
      [`${EXTRA_KEY_PREFIX}apple`]: true,
    })
  })
})

describe('legacy key migration (the prefix changed from custom|| to extra::)', () => {
  test('a LIVE legacy key is re-keyed, never silently dropped', () => {
    // Without this, every household with a persisted `checked` map would find
    // its checked extras silently unchecked on upgrade.
    const { map, changed } = reconcileCheckedExtras({ [`${LEGACY_EXTRA_KEY_PREFIX}kale`]: true }, [
      'kale',
    ])
    expect(map).toEqual({ [`${EXTRA_KEY_PREFIX}kale`]: true })
    expect(changed).toBe(true)
  })

  test('an ambiguous legacy key matching no live extra SURVIVES (never drops a line key)', () => {
    // Deliberate trade: `custom||<segment>` cannot be structurally told apart
    // from a line key for an ingredient normalizing to `custom`. When the
    // segment matches no live extra we keep the key rather than risk deleting
    // a real line's checked state — a stale extra check is visible and
    // self-corrects; a dropped grocery line is silent and breaks shopping.
    const { map, changed } = reconcileCheckedExtras(
      { [`${LEGACY_EXTRA_KEY_PREFIX}ghost`]: true },
      ['kale'],
    )
    expect(map).toEqual({ [`${LEGACY_EXTRA_KEY_PREFIX}ghost`]: true })
    expect(changed).toBe(false)
  })

  test('an orphan under the CURRENT prefix IS dropped (no ambiguity there)', () => {
    const { map, changed } = reconcileCheckedExtras({ [`${EXTRA_KEY_PREFIX}ghost`]: true }, ['kale'])
    expect(map).toEqual({})
    expect(changed).toBe(true)
  })

  test('migrates the legacy half of a mixed map, keeping line keys', () => {
    const { map } = reconcileCheckedExtras(
      {
        [`${LEGACY_EXTRA_KEY_PREFIX}kale`]: true,
        [`${EXTRA_KEY_PREFIX}apple`]: true,
        '999||tomato': true,
      },
      ['kale', 'apple'],
    )
    expect(map).toEqual({
      [`${EXTRA_KEY_PREFIX}kale`]: true,
      [`${EXTRA_KEY_PREFIX}apple`]: true,
      '999||tomato': true,
    })
  })
})
