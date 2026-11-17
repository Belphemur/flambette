/**
 * The household-notification trigger state machines (ADR-0102).
 *
 * PURE and store-free: the stores/views feed observations in, the machine
 * says whether the transition is a TRIGGER or a continuation. Everything
 * here is unit-pinned — the client-side half of the ADR's trigger rules.
 */

/**
 * The grocery-finished trigger: the false→true transition of "every
 * grocery line is checked", with a per-transaction latch so a burst of
 * final checks sends exactly one notification.
 *
 * The ALL-CHECKED verdict itself is never re-derived here: callers pass
 * the counts of the ONE derivation (`useGroceryList`'s `totalCount` /
 * `checkedCount`, the same numbers GroceryTab's auto-collapse reads), and
 * this machine only decides transitions. `total > 0` is the same "there
 * is a list" guard the section done-map uses (`lines.length > 0`).
 */
export class GroceryFinishLatch {
  /** The last observed all-checked state across EVERY observer. */
  #latched = false
  /** False until the FIRST observation arrives (see `observe`). */
  #primed = false

  /**
   * Observe one (total, checked) snapshot. Returns true exactly when the
   * all-checked verdict JUST transitioned false→true — the one moment a
   * notification is news. An uncheck re-arms the latch; re-checking fires
   * once more (a genuinely new completion).
   *
   * The FIRST observation is an ADOPTION, never a trigger: the watcher
   * runs immediately, so a device mounting into an already-all-checked
   * list (room adoption, hydrated stores, documents finishing loading)
   * would otherwise read that restored verdict as a fresh completion and
   * re-announce old news the household already saw. Only a transition
   * OBSERVED after the first one is a real local completion.
   */
  observe(totalCount: number, checkedCount: number): boolean {
    const allChecked = totalCount > 0 && checkedCount === totalCount
    if (!this.#primed) {
      this.#primed = true
      this.#latched = allChecked
      return false
    }
    if (allChecked === this.#latched) return false
    this.#latched = allChecked
    return allChecked
  }

  /** Test/observation seam: the current latched state. */
  get latched(): boolean {
    return this.#latched
  }
}
