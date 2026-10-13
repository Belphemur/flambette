import { useGroceryStore } from '../stores/grocery'
import { usePlanStore } from '../stores/plan'
import { useUiStore, type ConfirmTone } from '../stores/ui'

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

/**
 * THE confirm funnel (DRY, ADR-0084): the ONE question modal, hosted once
 * in App.vue — three call sites (the grocery clear, PlanTab's leave-room,
 * SettingsTab's leave-household) kept hand-rolling the same shape.
 *
 * Same call shape the old `confirmToast` had, minus `duration`: a modal
 * WAITS for an answer, there is no auto-dismiss to time out on.
 *
 * `onConfirm` is the WHOLE confirm action, deliberately: a site that
 * REPLACES the prompt with a result (the grocery clear) must not have the
 * helper dismiss on top of the replacement, and a site that completes
 * navigation itself (the cooking timer-leave) does it itself.
 * `onDismiss` passes straight through — the ui store fires it exactly once
 * on every end path (Confirm, Cancel, Escape, scrim — the modal's single
 * close event funnels to `settleConfirm`), and confirmAndClearGrocery's
 * settled guard depends on that.
 *
 * Tone defaults to 'danger': every current call site is a destructive
 * confirmation, so the confirm action wears ADR-0072's danger outline.
 */
export function confirmModal(
  message: string,
  options: {
    confirmLabel: string
    onConfirm: () => void
    onDismiss?: () => void
    tone?: ConfirmTone
  },
): void {
  useUiStore().showConfirm(
    { message, confirmLabel: options.confirmLabel, tone: options.tone },
    { onConfirm: options.onConfirm, onDismiss: options.onDismiss },
  )
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
 * Ask "Clear the grocery list?" with Clear / Cancel in the confirm modal
 * (no auto-dismiss — a modal waits) and clear on confirmation.
 * No-op (no prompt) when nothing is checked. Resolves once settled.
 *
 * The prompting guard is reset by the prompt's onDismiss, which the ui
 * store fires on EVERY end path — Confirm, Cancel, Escape, scrim, or
 * replacement by another question — so no end can ever wedge the guard
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

    confirmModal(message, {
      confirmLabel: 'Clear',
      // The status toast and the modal are SEPARATE store slots now, so a
      // result toast can never displace an open question — the old
      // replace-ordering dance (qodo finding 1) is retired with the toast
      // surface; the settled guard stays as belt-and-braces.
      onConfirm: () => {
        ui.showToast(
          'Grocery list cleared — ingredients return when you plan again',
        )
        settle(true)
      },
      onDismiss: () => settle(false),
    })
  })
}