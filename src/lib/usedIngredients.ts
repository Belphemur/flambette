/**
 * ADR-0103 (owner ruling 2026-11-26): the ONE key for an "I used that
 * ingredient" check, plus the ONE-SHOT handoff between the two cooking
 * surfaces.
 *
 * Both cooking surfaces derive their rows from `measuredAmounts.ts`; the
 * check must answer the same question on either surface. The key is built
 * from the STEP index, the STEP DETAIL-LINE index and the ingredient's
 * BASE `nameKey` — never the rendered quantity, which live-scales with
 * the servings stepper on the detail page and would orphan a check the
 * moment servings change. The base name keeps the key stable under a
 * dietary-restriction swap (the display name may change, the identity may
 * not).
 *
 * ADR-0103 owner ruling 2026-11-26 (final): COOKING keeps its used-set in
 * the ui store's persisted slice, keyed by recipe id + session start stamp,
 * capped at 24h and cleared by the one recordCook() path. DETAIL is fully
 * ephemeral. This module owns the keys and the ONE-SHOT handoff from the
 * detail sheet into that cooking session; the handoff itself stays module
 * memory and is consumed at most once.
 */

import { nameKey } from './grocery'
import type { MeasuredChip } from './measuredAmounts'

export function usedIngredientKey(stepIndex: number, chip: MeasuredChip): string {
  // `keyIngredient` is the BASE name: the restriction view's display name
  // may change without the ingredient's identity changing (qodo PR #120).
  return `${stepIndex}:${chip.lineIndex}:${nameKey(chip.keyIngredient)}`
}

/**
 * ADR-0103 decision 3b: the prep-card ingredient row and every step row
 * naming that same line item render from ONE ephemeral sheet set. This is
 * the prep row's key; `usedIngredientKey` is the step row's key, and
 * `MeasuredChip.itemId` is the bridge between them.
 */
export function ingredientRowKey(itemId: number): string {
  return `item:${itemId}`
}

/** True for a step-row key (handoff seeds only these into cooking mode). */
export function isStepUsedKey(key: string): boolean {
  return !key.startsWith('item:')
}

/** One-shot session handoff, held only for the lifetime of the tab. */
let pendingHandoff: { recipeId: number; keys: string[] } | null = null

/** The detail sheet seeds the cooking session when Start cooking is tapped. */
export function handOffUsedIngredients(recipeId: number, keys: Iterable<string>): void {
  pendingHandoff = { recipeId, keys: [...keys] }
}

/**
 * The cooking session consumes the handoff at mount. ANY take clears the
 * pending handoff, so a stale handoff can never seed a later cook of the
 * same recipe.
 */
export function takeUsedIngredientHandoff(recipeId: number): string[] {
  const pending = pendingHandoff
  pendingHandoff = null
  return pending?.recipeId === recipeId ? pending.keys : []
}
