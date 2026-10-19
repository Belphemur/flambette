import {
  clearedEntryForCheckedLine,
  clearedEntryIdentity,
  type ClearedSnapshotLine,
} from '../lib/grocery'
import type { ClearedIngredient } from '../stores/grocery'
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
 * Provider for the per-meal ingredient snapshots taken at clear time.
 * Registered by useGroceryList(), which owns the loaded recipe docs and
 * the ONE aggregation pass both halves come from:
 *
 * - `nameKeysByVariant`: variantId -> the variant's row nameKeys (the
 *   same keys `aggregateGroceries` groups on) — the whole-ingredient
 *   ledger input for the Clear-list flow and for the clear-checked
 *   merge when EVERY line of the ingredient is checked.
 * - `lineKeysByGroup`: nameKey -> the FULL checkbox keys currently
 *   rendered for that group. This is the line-granularity seam
 *   (PR #94 round 1, qodo/kody finding 1): a checked LINE key hides
 *   only its own line; a nameKey merges into the whole-ingredient
 *   ledger only when every sibling line is checked too, so checking
 *   `2 tbsp` can never hide the unchecked `30 ml` sibling.
 */
export interface ClearSnapshot {
  nameKeysByVariant: Record<number, string[]>
  lineKeysByGroup: Record<string, string[]>
  /** ADR-0094: the merged render's lines per group — key plus display (the
   *  display is what classifies a checked line's grammar branch; the key
   *  alone cannot: a raw row whose key source parsed spells a
   *  parsed-grammar key). Optional so test/legacy providers omit it. */
  linesByGroup?: Record<string, ClearedSnapshotLine[]>
  /** ADR-0094: per-variant OWN rendered lines per group (the variant's
   *  single-input aggregation) — the own-share source for line claims. */
  ownLinesByVariant?: Record<number, Record<string, ClearedSnapshotLine[]>>
  /** ADR-0094: per-variant clear-time serving context. */
  servingsByVariant?: Record<number, { servings: number; factor: number }>
}

let snapshotProvider: (() => ClearSnapshot) | null = null

export function registerClearSnapshotProvider(fn: () => ClearSnapshot): void {
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
    planStore.clearIngredientsForCurrentMeals(snapshotProvider().nameKeysByVariant)
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
 * - checked recipe-derived lines are merged into
 *   `clearedIngredients[variantId]` (via the plan store's merge
 *   primitive) at LINE granularity (PR #94 round 1, qodo/kody finding
 *   1): a checked line's FULL key hides only that rendered line; the
 *   ingredient's nameKey joins the whole-ingredient ledger only when
 *   EVERY rendered sibling line is checked, so checking `2 tbsp` never
 *   hides an unchecked `30 ml`. Already-cleared entries survive (merge,
 *   not the replace primitive).
 * - the checkbox map is wiped afterwards: it only ever held checked
 *   keys, and the surviving unchecked items must stay UNCHECKED.
 * - reports via the status toast; no modal. The count is the number of
 *   DISTINCT checked lines cleared (custom items + rendered recipe
 *   line keys), never the per-variant row tally (coderabbit/qodo
 *   finding 5).
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

  // (b) checked recipe-derived lines, at LINE granularity (qodo/kody
  // finding 1): the checked keys are matched against the snapshot's
  // currently-rendered line keys, so
  //
  // - a checked line hides ONLY its own line (its full key is merged
  //   into the variant's cleared set, where `aggregateGroceries`
  //   filters rendered lines by full key) — an unchecked sibling line
  //   (`2 tbsp` vs `30 ml`) stays visible, and so does any LATER
  //   re-sum of that line: the persisted full key matches the current
  //   render by unit identity (grocery.ts's lineKeyIdentity — the unit
  //   survives composition changes even when the summed basis does
  //   not), so cooking one co-contributing meal never resurrects the
  //   cleared line (kody round 2, K1);
  // - a nameKey joins the whole-ingredient ledger (the row-level skip)
  //   ONLY when every currently-rendered line of that group is checked;
  // - a checked key the current render does not contain (stale residue
  //   from a servings change) is simply wiped with the checkbox map —
  //   it can never hide a line that exists now. (A key merged at clear
  //   time is by construction current; it only goes stale LATER, and
  //   the unit-identity match above is what keeps it hiding.)
  const snapshot = snapshotProvider?.() ?? { nameKeysByVariant: {}, lineKeysByGroup: {} }
  const renderedLineKeys = new Set(Object.values(snapshot.lineKeysByGroup).flat())
  const checkedLineKeys = checkedKeys.filter(
    (k) => !k.startsWith(EXTRA_KEY_PREFIX) && renderedLineKeys.has(k),
  )
  // Group the checked line keys by their nameKey half.
  const checkedByNameKey = new Map<string, string[]>()
  for (const key of checkedLineKeys) {
    const nk = key.slice(0, key.indexOf('||'))
    const list = checkedByNameKey.get(nk)
    if (list) list.push(key)
    else checkedByNameKey.set(nk, [key])
  }

  // ADR-0094: both ledgers land in the SAME per-variant cleared list as
  // OBJECT entries — line claims carrying the variant's OWN share of the
  // merged line (from the snapshot's own-line view) plus the clear-time
  // serving context, and whole-ingredient (row) claims for fully checked
  // groups. `aggregateGroceries` skips a claimed ingredient's row at
  // ingestion and hides claimed lines by successor match — one persisted,
  // room-synced structure (the legacy `cleared` wire spelling is derived
  // from these objects at snapshot time, so an older peer's payload stays
  // one it can parse).
  const mergedByVariant: Record<number, ClearedIngredient[]> = {}
  const pushEntry = (variantId: number, entry: ClearedIngredient): void => {
    const list = mergedByVariant[variantId] ?? (mergedByVariant[variantId] = [])
    if (!list.some((e) => clearedEntryIdentity(e) === clearedEntryIdentity(entry))) list.push(entry)
  }
  for (const [rawId, nameKeys] of Object.entries(snapshot.nameKeysByVariant)) {
    const variantId = Number(rawId)
    const ctx =
      snapshot.servingsByVariant?.[variantId] ?? {
        servings: plan.plan.find((e) => e.variantId === variantId)?.servings ?? 1,
        factor: 1,
      }
    const ownByGroup = snapshot.ownLinesByVariant?.[variantId]
    for (const nk of new Set(nameKeys)) {
      const groupLines = snapshot.lineKeysByGroup[nk]
      const checkedForGroup = checkedByNameKey.get(nk)
      if (!groupLines?.length || !checkedForGroup) continue
      for (const key of checkedForGroup) {
        const display = snapshot.linesByGroup?.[nk]?.find((l) => l.key === key)?.display
        const entry = clearedEntryForCheckedLine(nk, { key, display }, ownByGroup?.[nk], ctx)
        if (entry) pushEntry(variantId, entry)
      }
      // The whole-ingredient ledger only ever takes FULLY checked
      // ingredients — the guard that keeps unchecked siblings visible.
      const fullyChecked = groupLines.every((line) => checkedForGroup.includes(line))
      if (fullyChecked) {
        pushEntry(variantId, {
          keyName: nk,
          unit: { kind: 'row' },
          factor: ctx.factor,
          servingsAtClear: ctx.servings,
          scope: 'ingredient',
        })
      }
    }
  }
  plan.mergeIngredientsForCurrentMeals(mergedByVariant)
  removed += checkedLineKeys.length

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