import { describe, expect, test } from 'bun:test'
import { isSuggestionListVisible } from './ingredientSuggestions'

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
