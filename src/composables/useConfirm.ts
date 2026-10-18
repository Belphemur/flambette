import { useGroceryStore } from '../stores/grocery'
import { usePlanStore } from '../stores/plan'
import { useUiStore, type ConfirmTone } from '../stores/ui'
import { extraCheckedKey, EXTRA_KEY_PREFIX } from '../lib/extraCheckedKeys'

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
 * ADR-0092's clear-checked: remove ONLY the checked lines, no confirm
 * modal. One shared implementation for BOTH the adaptive button and the
 * pull-to-clear gesture (Grocery tab and Shop view call this — never a
 * view copy).
 *
 * - checked custom items are removed from `plan.customItems`
 *   individually and their checked keys forgotten; the autocomplete
 *   memory in `customIngredients` SURVIVES (it is a separate store).
 * - checked recipe-derived nameKeys are MERGED into
 *   `clearedIngredients[variantId]` (via the plan store's merge
 *   primitive) for every planned meal that uses them — already-cleared
 *   entries survive (merge, not the replace primitive).
 * - the checkbox map is wiped afterwards: it only ever held checked
 *   keys, and the surviving unchecked items must stay UNCHECKED.
 * - reports via the status toast; no modal.
 *
 * Returns whether anything was cleared, so callers can skip a no-op.
 */
export function clearCheckedItems(): boolean {
  const grocery = useGroceryStore()
  const plan = usePlanStore()
  const ui = useUiStore()
  const checkedKeys = Object.keys(grocery.map).filter((k) => grocery.map[k] === true)
  if (checkedKeys.length === 0) return false

  let removed = 0

  // (a) checked custom items, individually. `[...plan.customItems]` so
  // the iteration is over a snapshot while removeCustomItem splices.
  for (const item of [...plan.customItems]) {
    const key = extraCheckedKey(item)
    if (grocery.map[key]) {
      plan.removeCustomItem(item)
      grocery.forget(key)
      removed += 1
    }
  }

  // (b) checked recipe-derived lines: intersect the checked map's
  // nameKey segments with the snapshot's per-variant nameKey lists, and
  // MERGE the hits into each variant's cleared set.
  const checkedNameKeys = new Set(
    checkedKeys
      .filter((k) => !k.startsWith(EXTRA_KEY_PREFIX))
      .map((k) => k.slice(0, k.indexOf('||'))),
  )
  const snapshot = snapshotProvider?.() ?? {}
  const mergedByVariant: Record<number, string[]> = {}
  for (const [rawId, nameKeys] of Object.entries(snapshot)) {
    const hits = nameKeys.filter((nk) => checkedNameKeys.has(nk))
    if (hits.length) {
      mergedByVariant[Number(rawId)] = hits
      removed += hits.length
    }
  }
  plan.mergeIngredientsForCurrentMeals(mergedByVariant)

  // (c) wipe the checkbox map — only checked keys ever live there.
  grocery.clearAll()

  ui.showToast(
    `Cleared ${removed} checked item${removed === 1 ? '' : 's'} — unchecked items remain`,
  )
  return true
}

/**
 * Ask "Clear the grocery list?" with Clear / Cancel in the confirm modal
 * (no auto-dismiss — a modal waits) and clear on confirmation.
 * No-op (no prompt) when nothing is checked, unless `options.force` —
 * ADR-0092's zero-checked "Clear list" branch (the button is visible
 * whenever the list has items, so its clear must clear). Resolves once
 * settled.
 *
 * The prompting guard is reset by the prompt's onDismiss, which the ui
 * store fires on EVERY end path — Confirm, Cancel, Escape, scrim, or
 * replacement by another question — so no end can ever wedge the guard
 * (qodo finding 1).
 */
export function confirmAndClearGrocery(
  message = 'Clear the grocery list? Ingredients stay hidden until you cook the meals.',
  options: { force?: boolean } = {},
): Promise<void> {
  return new Promise((resolve) => {
    const ui = useUiStore()

    // ADR-0092: the adaptive button's zero-checked "Clear list" branch
    // passes `force` — the button is visible whenever the list has items,
    // so its clear must actually clear even with nothing checked (the
    // old `!anythingChecked()` no-op would make the button lie).
    if (prompting || (!options.force && !anythingChecked())) {
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