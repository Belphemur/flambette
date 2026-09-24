import { useGroceryStore } from '../stores/grocery'
import { usePlanStore } from '../stores/plan'
import { useUiStore } from '../stores/ui'

/**
 * Clear-grocery confirmation workflow, shared by the Grocery tab and
 * Shopping mode.
 *
 * "Clear" wipes ONLY the grocery UI state: the checkbox map and the
 * free-form custom items. Planned meals stay in the plan (the grocery
 * list is derived, so it empties itself) — see the phase-7 brief.
 */

/**
 * One confirmation at a time: when the auto-trigger ("all items checked")
 * and the explicit button race, the second call is a no-op. Also stops
 * the watcher from re-prompting while a toast is up.
 */
let prompting = false

/** True when at least one grocery line is checked. */
function anythingChecked(): boolean {
  return Object.values(useGroceryStore().map).some(Boolean)
}

/** Wipe checkbox state + custom items; planned meals stay in the plan. */
function performClear(): void {
  useGroceryStore().clearAll()
  usePlanStore().clearCustomItems()
}

/**
 * Show a non-blocking confirmation toast ("Clear the grocery list?" with
 * Clear / Cancel, 10 s auto-dismiss) and clear on confirmation.
 * No-op (no prompt) when nothing is checked. Resolves once settled.
 *
 * The prompting guard is reset by the toast's onDismiss, which the ui
 * store fires on EVERY end path — timeout, replacement by another toast,
 * or dismissToast() — so a timed-out prompt can never wedge the guard
 * (qodo finding 1).
 */
export function confirmAndClearGrocery(
  message = 'Clear the grocery list?',
): Promise<void> {
  return new Promise((resolve) => {
    const ui = useUiStore()

    if (prompting || !anythingChecked()) {
      resolve()
      return
    }

    prompting = true
    let settled = false
    const settle = (clear: boolean) => {
      if (settled) return
      settled = true
      prompting = false
      if (clear) performClear()
      resolve()
    }

    ui.showToast(message, {
      duration: 10_000,
      onDismiss: () => settle(false),
      actions: [
        {
          label: 'Clear',
          run: () => {
            settle(true)
            ui.showToast('Grocery list cleared')
          },
        },
        {
          label: 'Cancel',
          run: () => ui.dismissToast(), // onDismiss settles the promise
        },
      ],
    })
  })
}