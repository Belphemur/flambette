import { computed, shallowRef, watch, triggerRef } from 'vue'
import {
  RESTRICTIONS,
  buildLadderIndex,
  ensureEvents,
  ensurePair,
  ensureRemoved,
  ensureSwaps,
  isRemovedByRestriction,
  normalizeRestrictionIds,
  type LadderIndex,
} from '../lib/restrictions'
import { useUiStore } from '../stores/ui'

/**
 * Reactive singleton over the restriction artifacts (the composable seam of
 * `src/lib/restrictions.ts`, whose functions stay pure).
 *
 * The runtime consumes a SPLIT TREE under `public/data/restrictions/`:
 *   * index.json       ~2 KB   the 12 entries {id, slug, label} + the pair file list — loaded ALWAYS (or read from the lib's RESTRICTIONS constant for cold start)
 *   * swaps.json       ~8 KB   the from→to entries with quantityRule + the drops lists — loaded when ANY restriction is active
 *   * removed/<slug>.json ~4 KB ×12  one restriction's removed recipe ids — loaded when THAT chip activates
 *   * pairs/<a>-<b>.json  ~1 KB ×66  ONLY the composition extras — loaded when THAT PAIR is active
 *
 * Cold start fires ZERO network requests beyond the bundle: index.json ships in
 * the bundle (or is read from the lib's RESTRICTIONS constant); swaps/removed/pairs
 * load only when a chip activates. The ladder (`ensureSwaps`, `ensureRemoved`,
 * `ensurePair`) is cached, retryable, and takes the fetch + base URL as parameters
 * so bun-test can exercise it without an environment.
 *
 * OUT OF SCOPE BY DECISION (the restriction ADR): the ACTIVE ids are a
 * device-local ui preference and do NOT ride the room payload — household
 * sync of restrictions is deferred (ADR-0031's reconciliation rules would
 * apply and need their own decision).
 */

const index = shallowRef<LadderIndex>(buildLadderIndex())

// Dedup guard: toggleRestriction (SettingsTab) and the activeIds watch both
// call ensureLoaded on the same transition. A memoized promise ensures only
// one ladder load runs at a time; concurrent callers await the same attempt
// (the original dictPromise pattern). A failure clears the memo so the next
// call retries.
let ensureLoadedPromise: Promise<void> | null = null

export function useRestrictions() {
  const ui = useUiStore()

  /** The device's active restriction ids, normalized (never trusted). */
  const activeIds = computed(() => normalizeRestrictionIds(ui.dietaryRestrictionIds))

  /** Catalog discovery filter: is this recipe removed by an active id? */
  function isRemoved(recipeId: number): boolean {
    return isRemovedByRestriction(recipeId, activeIds.value, index.value)
  }

  // Hydration race guard: pinia-plugin-persistedstate restores ui.dietaryRestrictionIds
  // asynchronously from localStorage. onMounted in the consuming component may fire
  // BEFORE hydration completes, leaving activeIds empty and ensureLoaded a no-op.
  // Watching activeIds catches the transition from [] to [id] and loads the data.
  watch(activeIds, (ids) => {
    if (ids.length > 0) void ensureLoaded()
  })

  /**
   * Load the split tree on demand — called only when a chip activates.
   * Each ladder step is cached and retryable: a failed fetch degrades to
   * identity (pre-load behaviour: no restriction is "active-looking" until
   * its data arrives) and is retried on the next activation.
   */
  async function ensureLoaded(): Promise<void> {
    // Dedup: if a load is already in progress, await it instead of starting a duplicate.
    if (ensureLoadedPromise) return ensureLoadedPromise
    const ids = activeIds.value
    if (ids.length === 0) return
    const baseUrl = import.meta.env.BASE_URL
    ensureLoadedPromise = (async () => {
      // swaps.json covers swaps AND drops (loaded when ANY chip is active).
      await ensureSwaps(index.value, fetch, baseUrl)
      // events/<slug>.json — the PER-RECIPE exact rework (loaded per chip;
      // takes precedence over the dictionary's global swap/drop union).
      const eventPromises = ids.map((id) => {
        const slug = RESTRICTIONS.find((r) => r.id === id)?.slug
        return slug ? ensureEvents(slug, index.value, fetch, baseUrl) : Promise.resolve()
      })
      await Promise.all(eventPromises)
      // removed/<slug>.json for each active restriction.
      const slugPromises = ids.map((id) => {
        const slug = RESTRICTIONS.find((r) => r.id === id)?.slug
        return slug ? ensureRemoved(slug, index.value, fetch, baseUrl) : Promise.resolve()
      })
      await Promise.all(slugPromises)
      // pairs/<a>-<b>.json for every active pair (3+ chip composition extras).
      const pairPromises: Promise<void>[] = []
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const a = RESTRICTIONS.find((r) => r.id === ids[i])?.slug
          const b = RESTRICTIONS.find((r) => r.id === ids[j])?.slug
          if (a && b) pairPromises.push(ensurePair(a, b, index.value, fetch, baseUrl))
        }
      }
      await Promise.all(pairPromises)
      // Nested mutations of index (swaps, drops, removed, pairs) don't trigger
      // shallowRef reactivity. triggerRef notifies Vue so dependents (grocery
      // displayLines, recipe detail views) recompute with the fresh data.
      triggerRef(index)
    })().finally(() => { ensureLoadedPromise = null })
    return ensureLoadedPromise
  }

  return {
    restrictions: RESTRICTIONS,
    activeIds,
    index,
    ensureLoaded,
    isRemoved,
  }
}
