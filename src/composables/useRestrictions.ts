import { computed, shallowRef } from 'vue'
import {
  RESTRICTIONS,
  buildDictIndex,
  isRemovedByRestriction,
  loadRestrictionDict,
  normalizeRestrictionIds,
  type DictIndex,
  type RestrictionDict,
} from '../lib/restrictions'
import { useUiStore } from '../stores/ui'

/**
 * Reactive singleton over the restriction artifacts (the composable seam of
 * `src/lib/restrictions.ts`, whose functions stay pure).
 *
 * `data/restriction_dict.json` (the ingredient substitution dictionary, built
 * by `scripts/build_restriction_dict.py`) is fetched once, lazily — only when
 * a restriction is ACTIVE, so an unrestricted install never spends the request.
 * The dictionary carries swaps (nameKey match → substitute name, base quantity
 * verbatim), removed sets (recipe ids), and pair extras, all in one ~1.4 MB
 * committed artifact. Everything is OFFLINE: static assets from the bundle,
 * never a mealime.com request (the e2e suite enforces that).
 *
 * OUT OF SCOPE BY DECISION (the restriction ADR): the ACTIVE ids are a
 * device-local ui preference and do NOT ride the room payload — household
 * sync of restrictions is deferred (ADR-0031's reconciliation rules would
 * apply and need their own decision).
 */

let dictPromise: Promise<RestrictionDict | null> | null = null
const dict = shallowRef<RestrictionDict | null>(null)
const index = shallowRef<DictIndex>(buildDictIndex(null))

export function useRestrictions() {
  const ui = useUiStore()

  /** The device's active restriction ids, normalized (never trusted). */
  const activeIds = computed(() => normalizeRestrictionIds(ui.dietaryRestrictionIds))

  /** Catalog discovery filter: is this recipe removed by an active id? */
  function isRemoved(recipeId: number): boolean {
    return isRemovedByRestriction(recipeId, activeIds.value, index.value)
  }

  /**
   * Idempotent: fetch the dictionary once. Fire-and-forget from consumers; a
   * failed load leaves the feature inert (no filtering, base docs everywhere)
   * until the next call retries. Concurrent callers awaited the same attempt;
   * whoever observes the failure clears the memo.
   */
  async function ensureLoaded(): Promise<void> {
    if (activeIds.value.length === 0) return
    dictPromise ??= loadRestrictionDict(fetch, import.meta.env.BASE_URL)
    const loaded = await dictPromise
    if (loaded) {
      dict.value = loaded
      index.value = buildDictIndex(loaded)
    } else {
      // A failed load is NOT memoized: the next ensureLoaded() retries, as
      // the documented contract says.
      dictPromise = null
    }
  }

  return {
    restrictions: RESTRICTIONS,
    activeIds,
    dict,
    index,
    ensureLoaded,
    isRemoved,
  }
}
