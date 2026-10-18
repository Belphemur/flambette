import { beforeEach, describe, expect, test } from 'bun:test'
import { createPinia, setActivePinia } from 'pinia'
import {
  confirmAndClearGrocery,
  clearCheckedItems,
  confirmModal,
  registerClearSnapshotProvider,
} from './useConfirm'
import { useGroceryStore } from '../stores/grocery'
import { usePlanStore } from '../stores/plan'
import { useCustomIngredientsStore } from '../stores/customIngredients'
import { extraCheckedKey } from '../lib/extraCheckedKeys'
import { useUiStore, type ConfirmPrompt } from '../stores/ui'
import type { VariantMeta } from '../lib/types'
import type { ClearSnapshot } from './useConfirm'

/**
 * ADR-0084's funnel contracts, pinned at the unit level:
 *
 *  1. ONE confirm at a time — the module-level `prompting` guard makes a
 *     racing second `confirmAndClearGrocery` a no-op, never a second
 *     question.
 *  2. `onDismiss` fires EXACTLY once on EVERY end path (Confirm, Cancel,
 *     and by construction Escape and scrim, which funnel to the same
 *     `settleConfirm`), and `onConfirm` runs before it on the confirm
 *     path.
 *  3. A settled question cannot settle twice — a late second settle is a
 *     no-op.
 */

/** Convenience: the store's open prompt, typed. */
function openPrompt(): ConfirmPrompt | null {
  return useUiStore().confirm
}

/** Snapshot literal with the line-key half defaulted (nameKeys-only callers). */
function snap(nameKeysByVariant: Record<number, string[]>, lineKeysByGroup: Record<string, string[]> = {}): ClearSnapshot {
  return { nameKeysByVariant, lineKeysByGroup }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('confirmModal (ADR-0084 funnel)', () => {
  test('opens the ONE ui-store slot with the question, label and tone', () => {
    confirmModal('Leave room xyz? Your plan stops syncing.', {
      confirmLabel: 'Leave',
      onConfirm: () => {},
    })
    expect(openPrompt()).toEqual({
      message: 'Leave room xyz? Your plan stops syncing.',
      confirmLabel: 'Leave',
      tone: 'danger',
    })
  })

  test("tone passes through ('brand' for a future non-destructive confirm)", () => {
    confirmModal('Keep going?', {
      confirmLabel: 'Go',
      tone: 'brand',
      onConfirm: () => {},
    })
    expect(openPrompt()?.tone).toBe('brand')
  })

  test('Confirm runs onConfirm then onDismiss once, and clears the slot', () => {
    let confirmed = 0
    let dismissed = 0
    confirmModal('Clear?', {
      confirmLabel: 'Clear',
      onConfirm: () => {
        confirmed += 1
      },
      onDismiss: () => {
        dismissed += 1
      },
    })
    useUiStore().settleConfirm(true)
    expect(confirmed).toBe(1)
    expect(dismissed).toBe(1)
    expect(openPrompt()).toBeNull()
  })

  test('Cancel (and, by the same close event, Escape/scrim) runs onDismiss once, never onConfirm', () => {
    let confirmed = 0
    let dismissed = 0
    confirmModal('Leave?', {
      confirmLabel: 'Leave',
      onConfirm: () => {
        confirmed += 1
      },
      onDismiss: () => {
        dismissed += 1
      },
    })
    useUiStore().settleConfirm(false)
    expect(confirmed).toBe(0)
    expect(dismissed).toBe(1)
    expect(openPrompt()).toBeNull()
  })

  test('a settled question cannot settle twice (late double-settle is a no-op)', () => {
    let dismissed = 0
    confirmModal('Clear?', {
      confirmLabel: 'Clear',
      onConfirm: () => {},
      onDismiss: () => {
        dismissed += 1
      },
    })
    useUiStore().settleConfirm(false)
    useUiStore().settleConfirm(false)
    expect(dismissed).toBe(1)
  })

  test('a second confirmModal while one is open REPLACES it — the displaced question ends through its own settle', () => {
    let firstDismissed = 0
    let secondDismissed = 0
    confirmModal('First question?', {
      confirmLabel: 'Do',
      onConfirm: () => {},
      onDismiss: () => {
        firstDismissed += 1
      },
    })
    confirmModal('Second question?', {
      confirmLabel: 'Do',
      onConfirm: () => {},
      onDismiss: () => {
        secondDismissed += 1
      },
    })
    expect(firstDismissed).toBe(1)
    expect(openPrompt()?.message).toBe('Second question?')
    useUiStore().settleConfirm(false)
    expect(secondDismissed).toBe(1)
  })
})

describe('confirmAndClearGrocery (prompting guard)', () => {
  test('nothing checked: no prompt, resolves immediately', async () => {
    await confirmAndClearGrocery()
    expect(openPrompt()).toBeNull()
    expect(useUiStore().confirm).toBeNull()
  })

  test('a racing second call while the prompt is up is a NO-OP (one confirmation at a time)', async () => {
    useGroceryStore().toggleChecked('custom||Olive oil')
    const first = confirmAndClearGrocery()
    expect(openPrompt()?.message).toBe(
      'Clear the grocery list? Ingredients stay hidden until you cook the meals.',
    )
    // The race: auto-trigger + button press in the same tick. The guard
    // must leave the FIRST question standing, not replace it.
    await confirmAndClearGrocery()
    expect(openPrompt()?.message).toBe(
      'Clear the grocery list? Ingredients stay hidden until you cook the meals.',
    )
    // Settle so the module-level guard does not leak into later tests.
    useUiStore().settleConfirm(false)
    await first
  })

  test('confirm clears the grocery state, fires the result toast, settles once', async () => {
    const grocery = useGroceryStore()
    grocery.toggleChecked('custom||Olive oil')
    usePlanStore().customItems = ['Olive oil']
    const pending = confirmAndClearGrocery()
    useUiStore().settleConfirm(true)
    await pending
    expect(Object.keys(grocery.map)).toEqual([]) // checkboxes wiped
    expect(usePlanStore().customItems).toEqual([]) // custom items wiped
    expect(useUiStore().toast?.message).toBe(
      'Grocery list cleared — ingredients return when you plan again',
    )
    expect(openPrompt()).toBeNull()
  })

  test('cancel keeps the grocery state and the guard unwedges for a retry', async () => {
    const grocery = useGroceryStore()
    grocery.toggleChecked('custom||Olive oil')
    usePlanStore().customItems = ['Olive oil']
    const pending = confirmAndClearGrocery()
    useUiStore().settleConfirm(false)
    await pending
    expect(grocery.map['custom||Olive oil']).toBe(true)
    expect(useUiStore().toast).toBeNull()
    // The guard is reset: a retry prompts again.
    const retry = confirmAndClearGrocery()
    expect(openPrompt()).not.toBeNull()
    useUiStore().settleConfirm(false)
    await retry
  })
})

function meta(id: number): VariantMeta {
  return { id, serving_count: 4 } as VariantMeta
}

describe('clearCheckedItems (ADR-0092)', () => {
  beforeEach(() => setActivePinia(createPinia()))

  test('checked recipe lines merge into clearedIngredients; unchecked stay unchecked', () => {
    const grocery = useGroceryStore()
    const plan = usePlanStore()
    plan.addToPlan(meta(7), 4)
    // The snapshot the grocery engine registers (its loaded-docs walk).
    registerClearSnapshotProvider(
      () => snap({ 7: ['flour', 'salt', 'butter'] }, { flour: ['flour||67.5 ml'], salt: ['salt||1 tsp'] }),
    )
    grocery.toggleChecked('flour||67.5 ml')
    grocery.toggleChecked('salt||1 tsp')
    grocery.toggleChecked('pepper||1 pinch')

    expect(clearCheckedItems()).toBe(true)
    // Checked gone (hidden via the MERGE): whole-ingredient nameKeys plus
    // the line keys (line-granular hiding rides the SAME cleared set).
    expect(plan.clearedIngredients[7]).toEqual([
      'flour',
      'salt',
      'flour||67.5 ml',
      'salt||1 tsp',
    ])
    // Unchecked remain and stay unchecked: the map was wiped (only
    // checked keys ever lived there) and pepper is NOT cleared.
    expect(grocery.map).toEqual({})
    expect(plan.clearedIngredients[7]).not.toContain('pepper')
    // Toast reports what happened.
    expect(useUiStore().toast?.message).toBe('Cleared 2 checked items — unchecked items remain')
  })

  test('checking ONE line of a multi-line ingredient never hides its unchecked siblings', () => {
    const grocery = useGroceryStore()
    const plan = usePlanStore()
    plan.addToPlan(meta(7), 4)
    // One ingredient, two rendered unit lines (qodo/kody finding 1).
    registerClearSnapshotProvider(
      () => snap({ 7: ['soy sauce', 'soy sauce'] }, { 'soy sauce': ['soy sauce||2 tbsp', 'soy sauce||30 ml'] }),
    )
    grocery.toggleChecked('soy sauce||2 tbsp')

    expect(clearCheckedItems()).toBe(true)
    // The cleared set holds the checked LINE key, never the bare nameKey:
    // `aggregateGroceries` filters the rendered line by full key, and the
    // `30 ml` sibling stays visible and unchecked.
    expect(plan.clearedIngredients[7]).toEqual(['soy sauce||2 tbsp'])
    expect(plan.clearedIngredients[7]).not.toContain('soy sauce')
    expect(grocery.map).toEqual({})
  })

  test('a nameKey joins the whole-ingredient ledger only when EVERY sibling line is checked', () => {
    const grocery = useGroceryStore()
    const plan = usePlanStore()
    plan.addToPlan(meta(7), 4)
    registerClearSnapshotProvider(
      () => snap({ 7: ['soy sauce', 'soy sauce'] }, { 'soy sauce': ['soy sauce||2 tbsp', 'soy sauce||30 ml'] }),
    )
    grocery.toggleChecked('soy sauce||2 tbsp')
    grocery.toggleChecked('soy sauce||30 ml')

    clearCheckedItems()
    // Fully checked: the row-level whole-ingredient skip takes over, so
    // the ingredient stays hidden across servings changes too.
    expect(plan.clearedIngredients[7]).toContain('soy sauce')
    expect(plan.clearedIngredients[7]).toContain('soy sauce||2 tbsp')
  })

  test('a checked key the current render does not contain is wiped, never cleared (stale residue)', () => {
    const grocery = useGroceryStore()
    const plan = usePlanStore()
    plan.addToPlan(meta(7), 4)
    // `salt||1 g` was checked before a servings change re-summed the line
    // to `salt||3 g`; the stale key must not hide the CURRENT line.
    registerClearSnapshotProvider(() => snap({ 7: ['salt'] }, { salt: ['salt||3 g'] }))
    grocery.toggleChecked('salt||1 g')

    expect(clearCheckedItems()).toBe(true)
    expect(plan.clearedIngredients[7]).toBeUndefined()
    expect(grocery.map).toEqual({})
  })

  test('the toast counts distinct cleared lines, not per-variant snapshot rows', () => {
    const grocery = useGroceryStore()
    const plan = usePlanStore()
    plan.addToPlan(meta(7), 4)
    plan.addToPlan(meta(8), 2)
    // `salt` is planned in TWO meals but renders as ONE checked line
    // (coderabbit finding 6): the old `removed += hits.length` per
    // variant reported "Cleared 2" for one ticked row.
    registerClearSnapshotProvider(() => snap({ 7: ['salt'], 8: ['salt'] }, { salt: ['salt||3 g'] }))
    grocery.toggleChecked('salt||3 g')

    clearCheckedItems()
    // Both variants carry the cleared nameKey (the line is shared), but
    // the toast counts the ONE line the shopper ticked.
    expect(plan.clearedIngredients[7]).toContain('salt')
    expect(plan.clearedIngredients[8]).toContain('salt')
    expect(useUiStore().toast?.message).toBe('Cleared 1 checked item — unchecked items remain')
  })

  test('merging preserves pre-existing cleared entries (replace would resurrect them)', () => {
    const grocery = useGroceryStore()
    const plan = usePlanStore()
    plan.addToPlan(meta(7), 4)
    plan.clearIngredientsForCurrentMeals({ 7: ['eggs'] })
    registerClearSnapshotProvider(() => snap({ 7: ['flour', 'eggs'] }, { flour: ['flour||500 g'] }))
    grocery.toggleChecked('flour||500 g')

    clearCheckedItems()
    expect(plan.clearedIngredients[7]).toEqual(['eggs', 'flour', 'flour||500 g'])
  })

  test('checked custom items are removed individually; the autocomplete memory survives', () => {
    const grocery = useGroceryStore()
    const plan = usePlanStore()
    plan.customItems = ['Olive oil', 'Paprika']
    grocery.toggleChecked(extraCheckedKey('Olive oil'))
    // Typed-name memory from an earlier add — must survive the clear.
    useCustomIngredientsStore().remember('Olive oil')
    registerClearSnapshotProvider(() => snap({}))

    expect(clearCheckedItems()).toBe(true)
    expect(plan.customItems).toEqual(['Paprika'])
    expect(grocery.map).toEqual({})
    expect(useUiStore().toast?.message).toBe('Cleared 1 checked item — unchecked items remain')
    expect(useCustomIngredientsStore().find('Olive oil')).toBeDefined()
  })

  test('nothing checked: no-op, no toast', () => {
    registerClearSnapshotProvider(() => snap({}))
    expect(clearCheckedItems()).toBe(false)
    expect(useUiStore().toast).toBeNull()
  })

  test('a checked nameKey no planned meal uses is wiped, never cleared', () => {
    const grocery = useGroceryStore()
    const plan = usePlanStore()
    plan.addToPlan(meta(7), 4)
    registerClearSnapshotProvider(() => snap({ 7: ['flour'] }))
    grocery.toggleChecked('ghost||1 x')

    clearCheckedItems()
    expect(plan.clearedIngredients[7]).toBeUndefined()
    expect(grocery.map).toEqual({})
  })

  test('the zero-checked "Clear list" branch forces the confirm past the empty guard', async () => {
    // The old guard no-opped when nothing was checked; ADR-0092's
    // "Clear list" label must actually clear (force option).
    const plan = usePlanStore()
    plan.addToPlan(meta(7), 4)
    registerClearSnapshotProvider(() => snap({ 7: ['flour'] }))
    const pending = confirmAndClearGrocery(undefined, { force: true })
    expect(openPrompt()?.message).toBe(
      'Clear the grocery list? Ingredients stay hidden until you cook the meals.',
    )
    useUiStore().settleConfirm(true)
    await pending
    expect(plan.clearedIngredients[7]).toEqual(['flour'])
    expect(plan.customItems).toEqual([])
  })
})
