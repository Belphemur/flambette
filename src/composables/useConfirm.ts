import { useGroceryStore } from '../stores/grocery'
import { usePlanStore } from '../stores/plan'
import { useUiStore } from '../stores/ui'

/**
 * Clear-grocery confirmation workflow, shared by the Grocery tab and
 * Shopping mode.
 *
 * "Clear" REMOVES the planned meals' ingredients from the grocery list:
 * each planned meal's ingredient names are snapshotted into the plan
 * store's clearedIngredients map (persisted, room-synced), so the derived
 * list stays empty until the meals are cooked or re-planned fresh. The
 * checkbox map and free-form custom items are wiped as before — see the
 * phase-9 brief.
 */

/**
 * One confirmation at a time: when the auto-trigger ("all items checked")
 * and the explicit button race, the second call is a no-op. Also stops
 * the watcher from re-prompting while a toast is up.
 */
let prompting = false

/**
 * Provider for the per-meal ingredient snapshots taken at clear time:
 * variantId -> nameKey-normalized ingredient keys. Registered by
 * useGroceryList(), which owns the loaded recipe docs the snapshot needs.
 */
let snapshotProvider: (() => Record<number, string[]>) | null = null

export function registerClearSnapshotProvider(fn: () => Record<number, string[]>): void {
  snapshotProvider = fn
}

/** True when at least one grocery line is checked. */
function anythingChecked(): boolean {
  return Object.values(useGroceryStore().map).some(Boolean)
}

/**
 * Snapshot + hide every planned meal's ingredients, wipe checkbox state
 * and custom items; planned meals stay in the plan.
 */
function performClear(): void {
  const planStore = usePlanStore()
  if (snapshotProvider) {
    planStore.clearIngredientsForCurrentMeals(snapshotProvider())
  }
  useGroceryStore().clearAll()
  planStore.clearCustomItems()
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
  message = 'Clear the grocery list? Ingredients stay hidden until you cook the meals.',
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
            ui.showToast(
              'Grocery list cleared — ingredients return when you plan again',
            )
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