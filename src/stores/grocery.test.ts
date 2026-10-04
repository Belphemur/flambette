import { beforeEach, describe, expect, test } from 'bun:test'
import { createPinia, setActivePinia } from 'pinia'
import { watch } from 'vue'
import { useGroceryStore } from './grocery'

/**
 * The grocery checkbox map is keyed by a LINE KEY, and an extra's key is
 * derived from its NAME (`custom||<lowercased name>`). That makes the
 * key's lifetime the extra's lifetime: an extra removed from the plan
 * must take its key with it, or re-adding it renders as already-done
 * (ADR-0050 addendum — the visible symptom was the sub-section's
 * done-map going false→true and auto-collapsing the group).
 */

describe('grocery checked map', () => {
  beforeEach(() => setActivePinia(createPinia()))

  test('forget drops exactly one key and leaves the rest alone', () => {
    const checked = useGroceryStore()
    checked.toggleChecked('custom||sticky tape')
    checked.toggleChecked('custom||celery')
    checked.toggleChecked('Produce||kale')

    checked.forget('custom||sticky tape')

    expect(checked.map['custom||sticky tape']).toBeUndefined()
    expect(checked.isChecked('custom||celery')).toBe(true)
    expect(checked.isChecked('Produce||kale')).toBe(true)
  })

  test('forget on an unknown key is a no-op (and never throws)', () => {
    const checked = useGroceryStore()
    checked.toggleChecked('custom||celery')
    const before = { ...checked.map }

    checked.forget('custom||never added')

    expect(checked.map).toEqual(before)
  })

  test('forget leaves the map reactive for the done-map watchers', () => {
    const checked = useGroceryStore()
    checked.toggleChecked('custom||celery')
    let seen = 0
    watch(
      () => checked.map,
      () => {
        seen += 1
      },
      // sync: the point of the immutable replacement is that a computed
      // done-map re-evaluates NOW; a pre-flush watcher would only fire
      // on the next tick and the test would measure nothing.
      { flush: 'sync' },
    )

    checked.forget('custom||celery')

    expect(seen).toBe(1)
    expect(checked.isChecked('custom||celery')).toBe(false)
  })
})
