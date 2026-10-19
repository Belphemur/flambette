import { defineStore } from 'pinia'
import { ref } from 'vue'
import { reconcileCheckedExtras, LEGACY_EXTRA_KEY_PREFIX } from '../lib/extraCheckedKeys'
import { usePlanStore } from './plan'

/**
 * One cleared-ingredient entry (ADR-0094): the stable, discriminated
 * identity of a grocery clear. The render's line filter re-derives the
 * successor claim from the IDENTITY alone — it maps the claim onto the
 * claiming variant's own CURRENT render of that identity (the shadow
 * aggregation, ADR-0094 review addendum) — so the stored kind payloads
 * and the clear-time serving context are informational (they spell what
 * was cleared and when, and feed the legacy `nameKey||basis` wire
 * spelling), never matched against.
 *
 * `approx` marks a claim whose stored amount carries NO trustworthy
 * clear-time context — every entry minted from a legacy `nameKey||basis`
 * string (the string model persisted the MERGED line key with no
 * per-variant share and no serving context). An approx claim matches by
 * identity PRESENCE (the rendered line whose unit identity equals the
 * claim's), which is exactly the pre-ADR-0094 identity semantics made
 * robust: the identity survives any re-sum, and one identity can match
 * at most one rendered line per group, so a sibling can never be
 * swallowed.
 */
export interface ClearedIngredient {
  /** BASE doc nameKey, e.g. `egg`, `soy sauce` (never the rendered `||basis`). */
  keyName: string
  /** Grammar class of the cleared line; discriminates the identity bucket. */
  unit:
    | { kind: 'byUnit'; unit: string; amount: number } // parsed quantity, e.g. `tbsp`, `ml`
    | { kind: 'container'; noun: string; annotation: string; count: number } // container phrase, e.g. `pkg`, `small bunch`
    | { kind: 'raw'; basis: string } // unparseable `raw||` row, e.g. `to taste`; basis verbatim
    | { kind: 'row' } // whole-ingredient clear (bare nameKey)
  /** Clear-time plan factor = entryServings / recipe.baseServings. */
  factor: number
  /** Serving count the plan held at clear time. */
  servingsAtClear: number
  /** `line` = hide one rendered line; `ingredient` = clear the whole ingredient group. */
  scope: 'line' | 'ingredient'
  /** Identity-presence claim (legacy string migration): amount advisory, never matched. */
  approx?: true
}

/**
 * Grocery checkbox state, keyed by grocery line key. Persisted to localStorage
 * under the `mealime-planner:v1:checked` key by pinia-plugin-persistedstate.
 */
export const useGroceryStore = defineStore(
  'grocery',
  () => {
    const map = ref<Record<string, boolean>>({})

    function isChecked(key: string): boolean {
      return map.value[key] === true
    }

    function toggleChecked(key: string): void {
      if (map.value[key]) delete map.value[key]
      else map.value[key] = true
    }

    /**
     * Drop ONE key (e.g. an extra that was removed). Extras' checkbox
     * keys are derived from their NAME, so removing an extra must also
     * drop its key — see ADR-0050's addendum: a leftover `custom||<name>`
     * made the re-added row read as already-done and the sub-section
     * watcher collapse the group that had just been emptied.
     */
    function forget(key: string): void {
      if (key in map.value) {
        const next = { ...map.value }
        delete next[key]
        map.value = next
      }
    }

    /**
     * Drop checked keys for extras that no longer exist, keeping every
     * other key untouched (recipe-derived line keys included).
     *
     * The guard is the point: `custom||<name>` keys are DERIVED from the
     * extras, so a key with no matching extra is residue from a room
     * snapshot or a backup import — either of which can carry
     * `customItems` and `checked` out of step. Left alone it reads as
     * "already done", so re-adding that name lands in a sub-section the
     * done-map calls COMPLETE, and ADR-0050's auto-collapse hides the new
     * row. See `src/lib/extraCheckedKeys.ts`.
     *
     * Returns whether anything was dropped, so callers can skip a no-op
     * write (and, in `applyRemote`, avoid an unnecessary republish).
     */
    function reconcileExtras(extras: readonly string[]): boolean {
      const { map: next, changed } = reconcileCheckedExtras(map.value, extras)
      if (changed) map.value = next
      return changed
    }

    /**
     * Migrate a PERSISTED map written by an older build, once, at hydrate.
     *
     * The ingress points (`applyRemote`, a backup restore) only cover state
     * arriving from OUTSIDE. A plain reload after the key-prefix
     * change is the case they miss: localStorage hydrates `custom||<name>`
     * keys while the renderers read `extraCheckedKey(name)` = `extra::<name>`,
     * so every already-checked extra would render UNCHECKED — the exact data
     * loss the reconciler's migration exists to prevent.
     *
     * `afterHydrate` is where the repo puts every other persisted-blob
     * migration (`ui.ts`: `migrateLegacyFilters`, `adoptHistoryShareDefault`,
     * `repairDefaultServings`), so this follows the established pattern rather
     * than inventing a startup path.
     *
     * It MUST be given the live extras: `reconcileCheckedExtras` re-keys a
     * legacy key only when its segment matches a real extra (that is how it
     * avoids mistaking a line key for an extras key), so reconciling against
     * an empty list would silently migrate nothing. The plan store is
     * persisted in its own slice and hydrates independently, so this reads it
     * lazily rather than assuming an order. Idempotent: a second run finds
     * nothing to migrate and writes nothing.
     */
    function migrateLegacyKeys(): void {
      if (!Object.keys(map.value).some((k) => k.startsWith(LEGACY_EXTRA_KEY_PREFIX))) return
      reconcileExtras(usePlanStore().customItems)
    }

    /** Wipe the whole checkbox map (used by the clear-grocery workflow). */
    function clearAll(): void {
      map.value = {}
    }

    return {
      map,
      isChecked,
      toggleChecked,
      clearAll,
      forget,
      reconcileExtras,
      migrateLegacyKeys,
    }
  },
  {
    persist: {
      key: 'mealime-planner:v1:checked',
      pick: ['map'],
      // The persisted blob may hold pre-ADR-0050 `custom||` keys. Hydration
      // has already run when this fires, so they can be re-keyed against the
      // live extras — the same shape as ui.ts's afterHydrate migrations.
      afterHydrate: (context) => {
        ;(context.store as unknown as { migrateLegacyKeys: () => void }).migrateLegacyKeys()
      },
    },
  },
)