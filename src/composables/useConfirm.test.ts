import { beforeEach, describe, expect, test } from 'bun:test'
import { createPinia, setActivePinia } from 'pinia'
import { confirmAndClearGrocery, confirmModal } from './useConfirm'
import { useGroceryStore } from '../stores/grocery'
import { usePlanStore } from '../stores/plan'
import { useUiStore, type ConfirmPrompt } from '../stores/ui'

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
