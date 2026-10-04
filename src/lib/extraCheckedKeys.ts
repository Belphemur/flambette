/**
 * Reconciling `custom||` checked keys against the live extras.
 *
 * An extra's checkbox key is DERIVED from its name
 * (`custom||<lowercased name>`), so the key and the extra it describes are
 * two facts that must agree. Nothing enforces that: `plan.customItems` and
 * the checked map are separate pieces of state that arrive together from
 * room snapshots, backup imports and share links — and any peer running
 * any version can send them out of step.
 *
 * When they disagree, the residue is invisible but not harmless. A leftover
 * `custom||<name>` for an extra that no longer exists reads as "already
 * done", so re-adding that name lands in a sub-section that the done-map
 * immediately considers COMPLETE — and ADR-0050's uniform auto-collapse
 * hides the row the user just added, behind its own header.
 *
 * `reconcileCheckedExtras` is the ONE place that knowledge lives, as a pure
 * function over plain data. It is deliberately NOT a watcher on
 * `customItems`: a watcher would need the grocery store inside the plan
 * store (which ADR-0050's addendum A2 rejected — the plan store is
 * room-synced and backup-registered, and the `custom||` key format belongs
 * to the renderers), and it would also fire on every unrelated mutation.
 * Instead the callers — the paths that can create the disagreement — run it
 * at their boundary.
 */

/** Prefix marking a checked key as belonging to a free-form "extra". */
export const EXTRA_KEY_PREFIX = 'custom||'

/** The checkbox key an extra is (and was) checked under. */
export function extraCheckedKey(name: string): string {
  return `${EXTRA_KEY_PREFIX}${name.toLowerCase()}`
}

/**
 * Drop every `custom||` key that no longer has a matching extra, and report
 * whether anything changed (so a caller can skip a no-op write).
 *
 * Keys that are NOT `custom||` are recipe-derived grocery line keys whose
 * lifecycle is the plan's, not the extras' — they are never touched here.
 * A key matching a live extra is kept, including a name that merely differs
 * in case: the key is lowercased on both sides.
 */
export function reconcileCheckedExtras(
  checked: Readonly<Record<string, boolean>>,
  extras: readonly string[],
): { map: Record<string, boolean>; changed: boolean } {
  const live = new Set(extras.map((name) => extraCheckedKey(name)))
  let changed = false
  const next: Record<string, boolean> = {}
  for (const [key, value] of Object.entries(checked)) {
    if (key.startsWith(EXTRA_KEY_PREFIX) && !live.has(key)) {
      changed = true
      continue
    }
    next[key] = value
  }
  return { map: changed ? next : (checked as Record<string, boolean>), changed }
}
