import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

/**
 * Per-line grocery quantity overrides (ADR-0100).
 *
 * The grocery quantity badge is a DERIVED projection — summed across the
 * contributing meals (ADR-0009 seasoning, ADR-0017 containers, ADR-0094
 * cleared claims) — so there is no stored per-line amount to edit. An
 * override is a household OVERRIDE of that projection for ONE rendered
 * line identity (`lineKeyIdentity`, grocery.ts — nameKey + unit identity,
 * the PR #94 round-2 helper), never a plan-servings edit.
 *
 * Semantics (ADR-0100, owner ruling):
 * - the map is `Record<lineKeyIdentity, amount-string>`; the string is
 *   clamped ONCE through the shared quantity parser (ADR-0037's rule)
 *   BEFORE the store write, and the store value IS the display value —
 *   the render localizes it through the same stack the derived sum uses,
 *   never re-parses or re-clamps;
 * - an overridden line renders INSTEAD the derived sum; sibling lines of
 *   the same ingredient (a different unit identity) are untouched;
 * - the override is scoped to the LINE, not the ingredient: a meal
 *   removed while other contributors keep the line alive keeps the
 *   override; the line leaving the list entirely orphans it — the render
 *   side sweeps orphans (`sweep`), so the map never outlives its line;
 * - an override on a line hidden by a cleared claim is inert (the claim's
 *   successor still carries the identity in the render's retention
 *   universe, so `sweep` keeps it — only a line that no longer EXISTS
 *   anywhere is orphaned);
 * - HOUSEHOLD state under the room's whole-state LWW (ADR-0028): a
 *   newer snapshot wins per store, an ABSENT `qtyOverrides` key means
 *   "don't touch" (never a wipe). ADEQUATE here: unlike ratings there is
 *   no un-override race — `Reset` deletes the key and the whole-state
 *   push writers carry the deletion, so no tombstone machinery is
 *   needed (a per-key LWW store without tombstones is only wrong when
 *   the deletion can race an absent-key-keeps push; every state push
 *   here carries the WHOLE map).
 */

export type QtyOverridesMap = Record<string, string>

/** Bound the payload the same way the other household lists travel. */
const OVERRIDES_CAP = 500

export const OVERRIDES_MAX_CHARS = 80

function validOverrideValue(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, OVERRIDES_MAX_CHARS)
}

/**
 * The ONE row-normalization funnel for override maps that did not go
 * through `set()` (backup import, room payload, hydration repair):
 * identity keys must be non-empty strings, values are clamped to a
 * trimmed non-empty string, an empty/unparseable value is a NO-OVERRIDE
 * (dropped, never stored as ""), duplicates are impossible in a record,
 * and the cap keeps the map's first-wins entries. Pure; unit-pinned.
 */
export function normalizeQtyOverrides(value: unknown): QtyOverridesMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const out: QtyOverridesMap = {}
  for (const [rawKey, raw] of Object.entries(value as Record<string, unknown>)) {
    const key = rawKey.trim()
    if (!key) continue
    const amount = validOverrideValue(raw)
    if (!amount) continue
    if (Object.keys(out).length >= OVERRIDES_CAP) break
    out[key] = amount
  }
  return out
}

export const useQtyOverridesStore = defineStore(
  'groceryQtyOverrides',
  () => {
    /** identity → override amount (the line's own unit grammar). */
    const map = ref<QtyOverridesMap>({})

    const count = computed(() => Object.keys(map.value).length)

    /** The stored override for one rendered line identity, if any. */
    function overrideFor(identity: string): string | undefined {
      return map.value[identity]
    }

    /**
     * Commit one override (the editor's Done). The written value must
     * ALREADY be normalized (the clamp happens at the caller through the
     * shared quantity parser, ADR-0037's clamp-once) — the store defense
     * trims only. A no-change write is skipped so the push watcher does
     * not fan an identical snapshot back to the room.
     */
    function set(identity: string, amount: string): boolean {
      const key = identity.trim()
      const value = validOverrideValue(amount)
      if (!key || !value) return false
      if (map.value[key] === value) return false
      const next = { ...map.value, [key]: value }
      if (Object.keys(next).length > OVERRIDES_CAP) return false
      map.value = next
      return true
    }

    /** Drop one override (the editor's Reset — back to the derived sum). */
    function clear(identity: string): void {
      const key = identity.trim()
      if (!key || map.value[key] === undefined) return
      const next = { ...map.value }
      delete next[key]
      map.value = next
    }

    /**
     * The render-side orphan sweep: keep exactly the identities the
     * caller's retention universe carries and drop the rest. Returns
     * true when anything was dropped (a no-change sweep must not write,
     * or the push watcher loops). The retention universe is the render's
     * own line identities IGNORING cleared-claim hiding — a hidden line
     * keeps its override (inert); a line that no longer exists anywhere
     * (its last contributing meal was removed/re-planned) releases it.
     */
    function sweep(keep: ReadonlySet<string>): boolean {
      const ids = Object.keys(map.value)
      const next: QtyOverridesMap = {}
      for (const id of ids) if (keep.has(id)) next[id] = map.value[id]
      if (ids.length === Object.keys(next).length) return false
      map.value = next
      return true
    }

    /** Repair a hydrated blob though the same funnel as remote/import. */
    function repairHydratedMap(): void {
      map.value = normalizeQtyOverrides(map.value)
    }

    /**
     * REPLACE the map wholesale (backup import, room snapshot): the
     * payload always runs the normalization funnel, so a buggy peer or a
     * hand-edited backup can never break the store's invariants.
     */
    function replaceAll(value: unknown): void {
      map.value = normalizeQtyOverrides(value)
    }

    return { map, count, overrideFor, set, clear, sweep, repairHydratedMap, replaceAll }
  },
  {
    persist: {
      key: 'mealime-planner:v1:groceryQtyOverrides',
      pick: ['map'],
      afterHydrate: (context) => {
        ;(context.store as unknown as { repairHydratedMap: () => void }).repairHydratedMap()
      },
    },
  },
)
