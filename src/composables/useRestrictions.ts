import { computed, shallowRef, ref } from 'vue'
import {
  RESTRICTIONS,
  SLUG_BY_ID,
  buildRestrictionIndex,
  createOverlayLoader,
  isRemovedByRestriction,
  normalizeRestrictionIds,
  overlayDocFor,
  type OverlayDoc,
  type OverlaysBySlug,
  type RestrictionIndex,
  type RestrictionSetsFile,
} from '../lib/restrictions'
import { useUiStore } from '../stores/ui'

/**
 * Reactive singleton over the restriction artifacts (the composable seam of
 * `src/lib/restrictions.ts`, whose functions stay pure).
 *
 * `data/restriction_sets.json` (the control plane) is fetched once, lazily —
 * only when a restriction is ACTIVE, so an unrestricted install never spends
 * the request. Overlay payloads load per active slug through the injected
 * loader (a failed fetch resolves null and retries; the app degrades to the
 * base doc). Everything is OFFLINE: static assets from the bundle, never a
 * mealime.com request (the e2e suite enforces that).
 *
 * OUT OF SCOPE BY DECISION (the restriction ADR): the ACTIVE ids are a
 * device-local ui preference and do NOT ride the room payload — household
 * sync of restrictions is deferred (ADR-0031's reconciliation rules would
 * apply and need their own decision).
 */

let setsPromise: Promise<RestrictionSetsFile | null> | null = null
const sets = shallowRef<RestrictionSetsFile | null>(null)
const index = shallowRef<RestrictionIndex>(buildRestrictionIndex(null))
const overlays = shallowRef<OverlaysBySlug>({})
const overlaysLoaded = ref(false)

async function loadSets(baseUrl: string): Promise<RestrictionSetsFile | null> {
  try {
    const res = await fetch(`${baseUrl}data/restriction_sets.json`)
    if (!res.ok) return null
    return (await res.json()) as RestrictionSetsFile
  } catch {
    return null
  }
}

export function useRestrictions() {
  const ui = useUiStore()

  /** The device's active restriction ids, normalized (never trusted). */
  const activeIds = computed(() => normalizeRestrictionIds(ui.dietaryRestrictionIds))

  /** Slugs that still need their overlay payload. */
  const missingSlugs = computed(() =>
    activeIds.value
      .map((id) => SLUG_BY_ID.get(id))
      .filter((slug): slug is string => !!slug && !(slug in overlays.value)),
  )

  /**
   * Idempotent: fetch the control plane, then every active slug's overlay.
   * Fire-and-forget from consumers; a failed load leaves the feature inert
   * (no filtering, base docs everywhere) until the next call retries.
   */
  async function ensureLoaded(): Promise<void> {
    if (activeIds.value.length === 0) return
    // loadSets appends `data/` itself (vite's SPA fallback answers a wrong
    // path 200-with-HTML, so a double prefix would fail INERT, not loudly).
    setsPromise ??= loadSets(import.meta.env.BASE_URL)
    const loaded = await setsPromise
    if (loaded) {
      sets.value = loaded
      index.value = buildRestrictionIndex(loaded)
    }
    if (missingSlugs.value.length === 0) {
      overlaysLoaded.value = true
      return
    }
    const load = createOverlayLoader(fetch, import.meta.env.BASE_URL)
    await Promise.all(
      missingSlugs.value.map(async (slug) => {
        const overlay = await load(slug)
        if (overlay) overlays.value = { ...overlays.value, [slug]: overlay }
      }),
    )
    overlaysLoaded.value = true
  }

  /** Catalog discovery filter: is this recipe removed by an active id? */
  function isRemoved(recipeId: number): boolean {
    return isRemovedByRestriction(recipeId, activeIds.value, index.value)
  }

  /** The reworked doc for this recipe, or null (base doc displays). */
  function overlayFor(recipeId: number): OverlayDoc | null {
    return overlayDocFor(recipeId, activeIds.value, overlays.value)
  }

  return {
    restrictions: RESTRICTIONS,
    activeIds,
    sets,
    index,
    overlays,
    overlaysLoaded,
    ensureLoaded,
    isRemoved,
    overlayFor,
  }
}
