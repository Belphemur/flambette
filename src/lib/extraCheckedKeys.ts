/**
 * Reconciling `custom||` checked keys against the live extras.
 *
 * An extra's checkbox key is DERIVED from its name
 * (`custom||<lowercased name>`), so the key and the extra it describes are
 * two facts that must agree. Nothing enforces that: `plan.customItems` and
 * the checked map are separate pieces of state that arrive together from
 * room snapshots and backup imports — and any peer running any version can
 * send them out of step. (One-shot `?p=` share links were a THIRD such
 * source; ADR-0051 retired them.)
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

/**
 * Prefix marking a checked key as belonging to a free-form "extra".
 *
 * The delimiter is `::`, NOT `||`, and that is load-bearing. Recipe-derived
 * grocery LINE keys are `` `${nameKey}||${display}` `` — the normalized
 * ingredient name is the first segment (`src/lib/grocery.ts`). An extras
 * prefix of `custom||` therefore shares its delimiter with a line key whose
 * ingredient normalizes to exactly `custom`, which would make the two
 * indistinguishable and let the reconciler below delete a real line's checked
 * state. No catalog ingredient normalizes to `custom` today (verified across
 * all 2,759 docs / 349 distinct names), but the catalog is data — a future
 * ingredient, a user-typed extra, or a renamed key must not be able to
 * collide silently. `::` cannot appear in a `nameKey` (it is built from
 * lowercased ingredient text), so the two key spaces are disjoint BY
 * CONSTRUCTION rather than by coincidence.
 *
 * Changing the prefix is a breaking change for existing `custom||` keys in
 * persisted `mealime-planner:v1:checked` maps and in any backup archive
 * carrying them; `legacyExtraKeyPrefix` below is what makes that migration
 * possible without stranding a household's checked extras.
 */
export const EXTRA_KEY_PREFIX = 'extra::'

/** The pre-ADR-0050 key form, still present in persisted maps and archives. */
export const LEGACY_EXTRA_KEY_PREFIX = 'custom||'

/** The checkbox key an extra is (and was) checked under. */
export function extraCheckedKey(name: string): string {
  return `${EXTRA_KEY_PREFIX}${name.toLowerCase()}`
}

/**
 * Drop every EXTRAS key that no longer has a matching extra, and report
 * whether anything changed (so a caller can skip a no-op write).
 *
 * Keys that are not extras keys are recipe-derived grocery line keys whose
 * lifecycle is the plan's, not the extras' — they are never touched here.
 * A key matching a live extra is kept, including a name that merely differs
 * in case: the key is lowercased on both sides.
 *
 * LEGACY (`custom||`) keys are treated as extras keys TOO, and migrated to
 * the current prefix when they still match a live extra. Without that, every
 * household with a persisted `mealime-planner:v1:checked` map would find its
 * checked extras silently unchecked on upgrade; with it, a legacy key that
 * no longer matches is dropped like any other orphan. Migration is what
 * keeps the stricter prefix from being a data-loss event.
 */
export function reconcileCheckedExtras(
  checked: Readonly<Record<string, boolean>>,
  extras: readonly string[],
): { map: Record<string, boolean>; changed: boolean } {
  const live = new Set(extras.map((name) => name.toLowerCase()))
  let changed = false
  const next: Record<string, boolean> = {}
  for (const [key, value] of Object.entries(checked)) {
    const extraName = extraNameFromKey(key)
    if (extraName === null) {
      // Not an extras key (a recipe-derived line key) — never ours to drop.
      next[key] = value
      continue
    }
    if (key.startsWith(LEGACY_EXTRA_KEY_PREFIX) && isLegacyLineKey(extraName, live)) {
      // Ambiguous legacy key that matches no live extra: it is far more likely
      // a real line key (`custom||<display>`) than an extra nobody has, so it
      // survives untouched. See `isLegacyLineKey`.
      next[key] = value
      continue
    }
    if (!live.has(extraName)) {
      changed = true
      continue
    }
    const canonical = `${EXTRA_KEY_PREFIX}${extraName}`
    if (canonical !== key) {
      // Legacy form, still live: re-key it rather than dropping the check.
      next[canonical] = value
      changed = true
      continue
    }
    next[key] = value
  }
  return { map: changed ? next : (checked as Record<string, boolean>), changed }
}

/**
 * The extra's lowercased name if `key` is an extras key, else `null`.
 *
 * The CURRENT prefix (`extra::`) cannot occur in a line key at all, so the
 * check is a plain prefix test.
 *
 * The LEGACY prefix (`custom||`) is ambiguous BY CONSTRUCTION: a line key
 * for an ingredient normalizing to `custom` has exactly that shape. It is
 * disambiguated structurally instead — a legacy EXTRAS key is
 * `custom||<lowercased extra name>`, and an extra name never contains the
 * line-key delimiter `||`, because `custom||a||b` would have to be an extra
 * literally named `a||b`. A user CAN type that, so it is not impossible,
 * only absurd; the cost of guessing wrong is one exotic extra silently
 * losing its check, versus the cost of NOT splitting: every line key whose
 * ingredient normalizes to `custom` is silently unchecked on each reconcile.
 * The second failure is silent and affects shopping; the first is visible
 * and vanishingly rare.
 */
function extraNameFromKey(key: string): string | null {
  if (key.startsWith(EXTRA_KEY_PREFIX)) return key.slice(EXTRA_KEY_PREFIX.length)
  if (key.startsWith(LEGACY_EXTRA_KEY_PREFIX)) return key.slice(LEGACY_EXTRA_KEY_PREFIX.length)
  return null
}

/**
 * Is this legacy key a real line key rather than a legacy extras key?
 *
 * Structure alone cannot decide it: `custom||<name>` is a valid legacy extras
 * key AND the shape of a line key for an ingredient normalizing to `custom`,
 * and `<name>` carries no marker. So decide it against the ACTUAL live extras —
 * the only ground truth available. A legacy key is treated as a line key when
 * its segment is not one of them, which is the safe direction: a real line
 * key is never dropped, and the cost is that an extra whose checked key
 * happens to be indistinguishable would keep a stale check rather than lose a
 * real one. Dropping a live grocery line is silent and breaks shopping;
 * keeping one stale extra check is visible and self-corrects the moment the
 * extra is re-added and unchecked.
 */
function isLegacyLineKey(name: string, live: ReadonlySet<string>): boolean {
  return !live.has(name)
}
