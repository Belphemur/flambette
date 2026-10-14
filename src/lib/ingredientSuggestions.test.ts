import { describe, expect, test } from 'bun:test'
import {
  capFuzzyPool,
  isSuggestionListVisible,
  suggestIngredients,
  type FuzzyDoc,
} from './ingredientSuggestions'
import type { CustomIngredient } from '../stores/customIngredients'

/**
 * The combobox is allowed to claim an expanded listbox ONLY while that
 * listbox is rendered (qodo + kody-ai, the same finding reported twice).
 * The category popup stands the suggestion rows down, so the answer has
 * to go false with them — this is the ONE rule behind the `v-if`,
 * `aria-expanded`, `aria-controls` and `aria-activedescendant`.
 */

describe('isSuggestionListVisible', () => {
  const shown = { open: true, categoryMenuOpen: false, rowCount: 3 }

  test('visible only when open, popup closed and there is at least one row', () => {
    expect(isSuggestionListVisible(shown)).toBe(true)
    expect(isSuggestionListVisible({ ...shown, open: false })).toBe(false)
    expect(isSuggestionListVisible({ ...shown, rowCount: 0 })).toBe(false)
  })

  test('the category popup stands the listbox down — the regression', () => {
    // While the popup is open the rows are NOT in the DOM, so every
    // ARIA binding must read collapsed/undefined here.
    expect(isSuggestionListVisible({ ...shown, categoryMenuOpen: true })).toBe(false)
  })

  test('no rows means no listbox even with the popup closed', () => {
    expect(isSuggestionListVisible({ open: true, categoryMenuOpen: false, rowCount: 0 })).toBe(
      false,
    )
  })
})

/**
 * The fuzzy tier (ADR-0086): a MiniSearch index over BOTH the baked
 * ingredient index AND the household's remembered names fills ONLY the
 * rows the exact tiers 0-2 leave empty under the 8-row cap. These tests
 * run against the REAL baked index (public/data/ingredients.json — the
 * same offline artifact the app loads), so a typo pin is a contract: a
 * re-extract that drops the row breaks the household's typing, not just
 * a fixture.
 */

/** A remembered entry the way the customIngredients store makes them. */
function mine(name: string, nameKey: string, category = 'Other'): CustomIngredient {
  return { name, nameKey, category }
}

describe('suggestIngredients — exact tiers (ADR-0012, unchanged contract)', () => {
  test('short queries stay closed — no listbox, no suggestions', async () => {
    expect(await suggestIngredients('', [])).toEqual([])
    expect(await suggestIngredients('a', [])).toEqual([])
  })

  test('exact tiers fill the cap — the fuzzy tier never runs', async () => {
    // 'tomato' has 12 exact nameKey matches (prefix + word-boundary) —
    // more than the 8-row cap, so every row is an exact-tier row and
    // the byte-for-byte order of tiers 0-2 is untouched.
    const rows = await suggestIngredients('tomato', [])
    expect(rows).toHaveLength(8)
    expect(rows.every((r) => r.nameKey.includes('tomato'))).toBe(true)
    expect(rows.every((r) => !r.mine)).toBe(true)
  })

  test('custom exact matches still outrank index rows of a higher tier', async () => {
    // 'milk 2' exact-matches the remembered entry (tier 0 via its own
    // nameKey) — the mine row keeps its remembered category.
    const custom = [mine('milk 2%', 'milk 2%')]
    const rows = await suggestIngredients('milk 2', custom)
    expect(rows[0]).toMatchObject({ name: 'milk 2%', nameKey: 'milk 2%', mine: true })
    expect(rows[0].category).toBe('Other')
  })
})

describe('suggestIngredients — fuzzy tier 3 (ADR-0086)', () => {
  test('a typo still finds the index row, with the index category', async () => {
    // 'bananna' exact-matches NOTHING in the 871-entry index; the fuzzy
    // tier resolves it to the single 'banana' nameKey → "bananas" row,
    // Produce, no mine badge (it comes from the baked index).
    const rows = await suggestIngredients('bananna', [])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      name: 'bananas',
      nameKey: 'banana',
      category: 'Produce',
      mine: false,
    })
    expect(rows[0].unit).toBeUndefined()
  })

  test('a typo of a remembered custom name surfaces the mine row', async () => {
    // 'glacier wter' exact-matches nothing; MiniSearch's per-token fuzzy
    // resolves 'wter'→'water' while 'glacier' hits the remembered name —
    // the mine row carries the remembered category, not a re-guess.
    const custom = [mine('Triple-filtered glacier water', 'triple-filtered glacier water')]
    const rows = await suggestIngredients('glacier wter', custom)
    const hit = rows.find((r) => r.mine && r.nameKey === 'triple-filtered glacier water')
    expect(hit).toBeDefined()
    expect(hit!.category).toBe('Other')
  })

  test('exact rows come FIRST — fuzzy only fills the rows left empty', async () => {
    // 'tomato juice' has exactly ONE exact nameKey match; the remaining
    // 7 rows come from the fuzzy tier (tomato/juice family) and must sit
    // AFTER the exact row, never before it.
    const rows = await suggestIngredients('tomato juice', [])
    expect(rows).toHaveLength(8)
    expect(rows[0]).toMatchObject({ nameKey: 'tomato juice', mine: false })
    expect(rows.slice(1).every((r) => r.nameKey !== 'tomato juice')).toBe(true)
    // Exact wins the top slot AND no fuzzy row duplicates it.
    expect(rows.filter((r) => r.nameKey === 'tomato juice')).toHaveLength(1)
  })

  test('the 8-row cap is respected by the combined exact+fuzzy list', async () => {
    // 'milk 2' has 1 exact (custom) row plus 20+ fuzzy milk-family hits —
    // the merged list must still cap at 8.
    const custom = [mine('milk 2%', 'milk 2%')]
    const rows = await suggestIngredients('milk 2', custom)
    expect(rows.length).toBeGreaterThan(1)
    expect(rows.length).toBeLessThanOrEqual(8)
  })

  test('fuzzy rows dedupe by nameKey against exact rows and each other', async () => {
    // 'tomato' fills the cap with exact rows, so the fuzzy tier adds
    // nothing — its own hits (the same tomato family) are all deduped.
    const rows = await suggestIngredients('tomato', [])
    const keys = rows.map((r) => r.nameKey)
    expect(new Set(keys).size).toBe(keys.length)
  })

  test('determinism: repeated calls return byte-identical rows', async () => {
    const custom = [mine('Triple-filtered glacier water', 'triple-filtered glacier water')]
    const a = await suggestIngredients('glacier wter', custom)
    const b = await suggestIngredients('glacier wter', custom)
    expect(b).toEqual(a)
    // Same for a pure-fuzzy index query, second call hitting the cache.
    const c = await suggestIngredients('bananna', [])
    const d = await suggestIngredients('bananna', [])
    expect(d).toEqual(c)
  })

  test('capFuzzyPool: the score-then-name tie-break is GLOBAL across the cutoff (qodo round-5)', () => {
    // MiniSearch returns equal-score hits in internal order, not
    // alphabetical. With an early break at the cutoff, 'zucchini'
    // (returned first) would take the row while alphabetically earlier
    // 'apple' and 'banana' — the SAME score — are dropped. The cap must
    // rank the WHOLE eligible pool first, then slice.
    const doc = (id: string, name: string): [string, FuzzyDoc] => [
      id,
      { id, key: id, name, category: 'Produce', mine: false },
    ]
    const docs = new Map<string, FuzzyDoc>([
      doc('a', 'apple'),
      doc('b', 'banana'),
      doc('z', 'zucchini'),
    ])
    const hits = [
      { id: 'z', score: 2 },
      { id: 'b', score: 2 },
      { id: 'a', score: 2 },
    ]
    expect(capFuzzyPool(hits, docs, new Set(), 2)).toEqual([
      expect.objectContaining({ nameKey: 'a' }),
      expect.objectContaining({ nameKey: 'b' }),
    ])
    // A strictly-higher score still wins its slot regardless of name.
    expect(capFuzzyPool([{ id: 'z', score: 3 }, ...hits.slice(1)], docs, new Set(), 2)).toEqual([
      expect.objectContaining({ nameKey: 'z' }),
      expect.objectContaining({ nameKey: 'a' }),
    ])
  })

  test('capFuzzyPool: exact rows stay deduped and room<=0 stays empty', () => {
    const docs = new Map<string, FuzzyDoc>([
      ['a', { id: 'a', key: 'a', name: 'apple', category: 'Produce', mine: false }],
      ['m', { id: 'm', key: 'm', name: 'apple', category: 'Other', mine: true }],
    ])
    const hits = [
      { id: 'm', score: 2 },
      { id: 'a', score: 2 },
    ]
    // Same display name, different keys: BOTH rows survive (nameKey dedupe).
    expect(capFuzzyPool(hits, docs, new Set(), 8)).toHaveLength(2)
    // An exact tier already owns 'a' — the fuzzy tier drops it.
    expect(capFuzzyPool(hits, docs, new Set(['a']), 8)).toHaveLength(1)
    expect(capFuzzyPool(hits, docs, new Set(), 0)).toEqual([])
  })

  test('a changed custom list rebuilds the fuzzy index (new array identity)', async () => {
    // The store replaces the array on every mutation, so a NEW array
    // with a new remembered name must surface — even for a typo'd query.
    const before = await suggestIngredients('glacier wter', [])
    expect(before.some((r) => r.nameKey === 'triple-filtered glacier water')).toBe(false)
    const after = await suggestIngredients('glacier wter', [
      mine('Triple-filtered glacier water', 'triple-filtered glacier water'),
    ])
    expect(after.some((r) => r.mine && r.nameKey === 'triple-filtered glacier water')).toBe(true)
  })
})
