import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { VariantMeta } from '../lib/types'

export interface PlanEntry {
  variantId: number
  servings: number
}

/** One "cooked this meal" event, newest first in the history.
 *
 *  One row PER EVENT: cooking the same meal twice appends two rows so
 *  the UI can aggregate a cook count (ADR-0011). Newest first, capped.
 */
export interface CookedEntry {
  variantId: number
  cookedAt: number
  /**
   * Per-device unique id for this cook event. Two phones can cook the same
   * recipe in the same millisecond; (variantId, cookedAt) alone then collides
   * and a merge would drop one. `id` disambiguates them (ADR-0011/0032).
   * Backward-compatible: older rows imported via backup or received from an
   * older peer lack it, and mergeCookedHistory falls back to the pair.
   */
  id?: string
  /**
   * Identity of the plan this cook was made under (ADR-0034), so the
   * History tab can answer "what plan and when was it put together".
   * Optional for back-compat: rows written by an older peer, or imported
   * from an older backup, lack it and group under "earlier cooks".
   * Ad-hoc cooks (no plan) get a freshly minted one-recipe plan id.
   */
  planId?: string
  /** When that plan was started (empty -> non-empty), or the cook time for
   *  an ad-hoc plan. Drives the order of the plan groups in History. */
  planCreatedAt?: number
}

/** Provenance of the plan a cook event was recorded under. */
export interface PlanIdentity {
  planId: string
  planCreatedAt: number
}

/** cookedHistory keeps at most this many entries, newest first. */
const COOKED_HISTORY_CAP = 200
const COOKED_RECENT_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Stable identity key for a cook event: the per-device id when the row
 * carries one, the (variantId, cookedAt) pair otherwise (legacy rows from
 * older peers / imports). Used for BOTH dedupe and the cap tie-break, so
 * the ordering is a total order and every device sorts identically.
 */
export function cookedEventKey(row: CookedEntry): string {
  return row.id ?? `${row.variantId}@${row.cookedAt}`
}

/**
 * Per-JS-context random device nonce backing CookedEntry.id: a reload
 * regenerates it, which is exactly why a bare monotonic counter would
 * collide with ids already persisted on this device or minted by another
 * phone — the nonce makes every session's id space disjoint from every
 * other (time + counter alone would re-collide after a reload while the
 * persisted history keeps its old ids).
 */
const cookDeviceNonce = Math.random().toString(36).slice(2, 10)
let cookIdSeq = 0

/** Mint a globally-unique id for a new cook event (ADR-0032). */
function nextCookedId(): string {
  return `${cookDeviceNonce}-${Date.now().toString(36)}-${cookIdSeq++}`
}

let planIdSeq = 0

/** Mint a plan identity. The `plan-` prefix keeps ad-hoc plan ids from
 *  ever colliding with a persisted planId in the same household (ADR-0034). */
function nextPlanId(): string {
  return `plan-${cookDeviceNonce}-${Date.now().toString(36)}-${planIdSeq++}`
}

/**
 * Meal plan: list of {variantId, servings}. Persisted to localStorage under
 * the `mealime-planner:v1:plan` key by pinia-plugin-persistedstate.
 */
export const usePlanStore = defineStore(
  'plan',
  () => {
    const plan = ref<PlanEntry[]>([])
    /** Identity of the CURRENT plan instance (ADR-0034): minted when the
     *  plan goes empty -> non-empty, invalidated when it empties again, so
     *  the next meal added starts a new plan. Empty means "not yet minted"
     *  — a legacy install that predates ADR-0034 mints lazily instead of
     *  running a migration write. */
    const planId = ref<string>('')
    const planCreatedAt = ref<number>(0)
    /** Free-form extra grocery items (not tied to any recipe). */
    const customItems = ref<string[]>([])
    /** Cooked history (ADR-0032): shared with the room by default, still
     *  opt-out per device. Part of the shared room state when the user
     *  has the sharing on. */
    const cookedHistory = ref<CookedEntry[]>([])
    /** variantId -> nameKey-normalized ingredient keys cleared from the
     *  grocery list for that meal. Stays until the meal is cooked or
     *  re-planned fresh. Part of the shared room state. */
    const clearedIngredients = ref<Record<number, string[]>>({})

    function planContains(variantId: number): boolean {
      return plan.value.some((e) => e.variantId === variantId)
    }

    /**
     * Adopt a plan identity from the room, or clear it (ADR-0034). Whole
     * state, not a reconciled record: there is only ever one current plan
     * in a household, so the newer snapshot simply wins.
     */
    function setPlanIdentity(identity: PlanIdentity | null): void {
      if (identity && identity.planId) {
        planId.value = identity.planId
        planCreatedAt.value = Number.isFinite(identity.planCreatedAt) ? identity.planCreatedAt : 0
      } else {
        planId.value = ''
        planCreatedAt.value = 0
      }
    }

    /** The current plan's identity, minting it on first use (ADR-0034).
     * Callers that need the identity of a cook they are ABOUT to record
     * must read it BEFORE the meal leaves the plan.
     */
    function ensurePlanIdentity(): PlanIdentity {
      if (!planId.value) {
        planId.value = nextPlanId()
        planCreatedAt.value = Date.now()
      }
      return { planId: planId.value, planCreatedAt: planCreatedAt.value }
    }

    /**
     * The plan identity a cook of `variantId` belongs to (ADR-0034):
     * the real plan when the meal is in it, else a freshly minted ad-hoc
     * one-recipe plan (owner rule: a cook started without a plan is
     * treated as a plan containing only that recipe). The ad-hoc identity
     * is returned but NEVER stored, so an ad-hoc cook can neither adopt
     * nor become the household's real plan.
     *
     * Callers capture this ONCE per cooking session, so a mid-cook mark
     * and the session's Finish land in the same ad-hoc plan.
     */
    function cookPlanIdentity(variantId: number): PlanIdentity {
      if (planContains(variantId)) return ensurePlanIdentity()
      return { planId: nextPlanId(), planCreatedAt: Date.now() }
    }

    /**
     * Add (or re-scale) a planned meal.
     *
     * `servings` is REQUIRED (ADR-0037). It used to default to
     * `meta.serving_count`, which is how the authored 6 leaked into every
     * add path; the remembered default lives in the ui store, and a
     * required argument makes each caller state which count it means
     * instead of inheriting a recipe fact. An invalid count still floors
     * at 1, as the UI's own stepper does.
     */
    function addToPlan(meta: VariantMeta, servings: number): void {
      const count = Number.isFinite(servings) ? Math.max(1, Math.round(servings)) : 1
      const existing = plan.value.find((e) => e.variantId === meta.id)
      if (existing) {
        existing.servings = count
        return
      }
      // Fresh planning = fresh ingredients: forget any cleared snapshot.
      delete clearedIngredients.value[meta.id]
      // First meal of a plan starts a new plan identity (ADR-0034): the
      // previous one was invalidated when the plan emptied.
      if (plan.value.length === 0) {
        planId.value = ''
        planCreatedAt.value = 0
      }
      plan.value.push({ variantId: meta.id, servings: count })
      ensurePlanIdentity()
    }

    function removeFromPlan(variantId: number): void {
      const i = plan.value.findIndex((e) => e.variantId === variantId)
      if (i < 0) return
      plan.value.splice(i, 1)
      // An emptied plan is a finished plan: the next meal added belongs to
      // a NEW plan, not to this one (ADR-0034).
      if (plan.value.length === 0) {
        planId.value = ''
        planCreatedAt.value = 0
      }
    }

    function setServings(variantId: number, servings: number): void {
      const entry = plan.value.find((e) => e.variantId === variantId)
      if (entry) entry.servings = Math.max(1, servings)
    }

    function clearPlan(): void {
      plan.value = []
      planId.value = ''
      planCreatedAt.value = 0
    }

    /** Add a free-form grocery item (deduped case-insensitively). */
    function addCustomItem(text: string): boolean {
      const t = text.trim().slice(0, 80)
      if (!t) return false
      if (customItems.value.some((i) => i.toLowerCase() === t.toLowerCase())) return false
      customItems.value.push(t)
      return true
    }

    function removeCustomItem(text: string): void {
      const i = customItems.value.indexOf(text)
      if (i >= 0) customItems.value.splice(i, 1)
    }

    /** Empty the free-form grocery items (used by the clear-grocery workflow). */
    function clearCustomItems(): void {
      customItems.value = []
    }

    /**
     * Clear-grocery workflow: snapshot each currently planned meal's
     * ingredient name keys (per-variant maps of nameKey-normalized names,
     * provided by the caller — the grocery engine holds the recipe docs).
     * The cleared ingredients stay hidden in the derived grocery list until
     * the meal is cooked or re-planned fresh.
     */
    function clearIngredientsForCurrentMeals(keysByVariant: Record<number, string[]>): void {
      for (const entry of plan.value) {
        const keys = keysByVariant[entry.variantId]
        if (keys?.length) {
          clearedIngredients.value[entry.variantId] = [...new Set(keys)]
        }
      }
    }

    /** Forget a meal's cleared snapshot (meal re-planned or cooked). */
    function restoreIngredients(variantId: number): void {
      delete clearedIngredients.value[variantId]
    }

    /** Replace the cleared map wholesale (room-sync apply path). */
    function setClearedIngredients(value: Record<number, string[]>): void {
      clearedIngredients.value = value
    }

    /**
     * Mark a meal as cooked: drop it from the plan and record a cooked
     * EVENT in the personal (not room-synced) cooked history, newest
     * first, capped. Every cook appends its own row — the UI aggregates
     * per-variant counts (ADR-0011). Its grocery lines disappear
     * automatically — the list is derived — and its cleared snapshot is
     * forgotten (nothing left to remember).
     *
     * The event is stamped with the provenance of the plan it was cooked
     * under (ADR-0034): the caller passes the session's plan identity
     * (captured BEFORE the meal left the plan — see `cookPlanIdentity`),
     * or we resolve it here, which is what the Plan tab's per-meal button
     * relies on. Returns the event so the caller can undo it.
     */
    function markCooked(variantId: number, ctx?: PlanIdentity): CookedEntry {
      const identity = ctx ?? cookPlanIdentity(variantId)
      const event: CookedEntry = {
        variantId,
        cookedAt: Date.now(),
        id: nextCookedId(),
        planId: identity.planId,
        planCreatedAt: identity.planCreatedAt,
      }
      removeFromPlan(variantId)
      restoreIngredients(variantId)
      cookedHistory.value = [event, ...cookedHistory.value].slice(0, COOKED_HISTORY_CAP)
      return event
    }

    /**
     * Drop one cook event by id (the undo half of `markCooked`,
     * ADR-0034). Matching is on the event key, so a row without an id
     * (legacy import) is still addressable by its (variantId, cookedAt)
     * pair. Restoring the plan membership is the caller's job — it owns
     * the prior-plan snapshot the undo toast was built from.
     */
    function unmarkCooked(event: CookedEntry): boolean {
      const key = cookedEventKey(event)
      const i = cookedHistory.value.findIndex((r) => cookedEventKey(r) === key)
      if (i < 0) return false
      cookedHistory.value.splice(i, 1)
      return true
    }

    /** True when the meal was cooked in the last 30 days. */
    function isCookedRecently(variantId: number): boolean {
      const cutoff = Date.now() - COOKED_RECENT_MS
      return cookedHistory.value.some((e) => e.variantId === variantId && e.cookedAt >= cutoff)
    }

    /** Replace the cooked history wholesale (backup import). */
    function replaceCookedHistory(rows: CookedEntry[]): void {
      cookedHistory.value = rows
        .filter((r) => Number.isFinite(r.variantId) && Number.isFinite(r.cookedAt))
        // Preserve the per-device id: a household member's backup restores
        // the SAME event other peers hold under its id, and dropping it
        // here would make the restored copy key by the pair — the next
        // merge would count the event twice. Rows without an id (legacy
        // backups) keep the pair fallback.
        // Plan provenance is preserved too (ADR-0034): rebuilding the row
        // field-by-field is what would otherwise silently drop it.
        .map((r) => ({
          variantId: r.variantId,
          cookedAt: r.cookedAt,
          ...(r.id !== undefined ? { id: r.id } : {}),
          ...(r.planId !== undefined ? { planId: r.planId } : {}),
          ...(r.planCreatedAt !== undefined ? { planCreatedAt: r.planCreatedAt } : {}),
        }))
        .slice(0, COOKED_HISTORY_CAP)
    }

    /**
     * Union an inbound household history into ours (ADR-0032).
     *
     * History is append-only and there is no delete feature, so a
     * peer's SHORTER list is never a statement that our rows should
     * disappear — it only means that peer has cooked less. Since
     * history now syncs by default, every device in a household pushes
     * its own list at once, and the old whole-state replace would let
     * whoever pushed last erase the other phones' cooks. Deduplicated on
     * (variantId, cookedAt), newest first, same cap.
     */
    function mergeCookedHistory(rows: CookedEntry[]): boolean {
      const seen = new Set<string>()
      const merged: CookedEntry[] = []
      // Seed with the CURRENT household view so inbound rows that duplicate
      // what we already hold don't count as "added" and don't get republished.
      for (const row of [...cookedHistory.value]) {
        seen.add(cookedEventKey(row))
        merged.push({ ...row })
      }
      // Keys of rows that came in from THIS merge — a row that duplicates a
      // local one is not an addition, and a row the CAP discards must not
      // report an addition either (it would make both devices republish
      // their unchanged history forever: rev ping-pong).
      const inboundKeys = new Set<string>()
      for (const row of rows) {
        if (!Number.isFinite(row.variantId) || !Number.isFinite(row.cookedAt)) continue
        // Prefer the per-device unique id when present (disambiguates two
        // same-recipe cooks on different phones in the same millisecond,
        // which the pair alone collides on). Fall back to (variantId, cookedAt)
        // for rows from older peers / imports that lack it.
        const key = cookedEventKey(row)
        if (seen.has(key)) continue
        seen.add(key)
        merged.push({ ...row })
        inboundKeys.add(key)
      }
      // Newest first, with a DETERMINISTIC tie-break: two devices that hold
      // different events with the same boundary timestamp must sort them the
      // same way, or each device keeps its own event at the cap edge and
      // endlessly republishes the other's discard. The event key is unique
      // within the merged list, so this is a total order.
      merged.sort(
        (a, b) =>
          b.cookedAt - a.cookedAt ||
          cookedEventKey(a).localeCompare(cookedEventKey(b)),
      )
      cookedHistory.value = merged.slice(0, COOKED_HISTORY_CAP)
      let added = 0
      for (const row of cookedHistory.value) {
        if (inboundKeys.has(cookedEventKey(row))) added++
      }
      return added > 0
    }

    /**
     * The undo half of `markCooked` (ADR-0034): drop the event again and
     * put the plan back exactly as it was. The prior plan entry and its
     * cleared-ingredient row are captured by the CALLER at press time —
     * after `markCooked` neither is knowable. The plan IDENTITY is
     * restored too (from the event, which names the plan the meal was
     * taken out of), so an undo of a mid-cook mark does not leave the
     * household's plan looking like a different plan than it is.
     * An ad-hoc cook has no plan entry to restore, and the event is all
     * that is removed.
     */
    function undoMarkCooked(
      event: CookedEntry,
      prior: { entry: PlanEntry | null; cleared: string[] | null },
    ): void {
      unmarkCooked(event)
      if (!prior.entry) return
      if (!planContains(prior.entry.variantId)) {
        plan.value.push({ ...prior.entry })
      }
      // Restore the identity ONLY if this device is still on that plan.
      // If the cook emptied the plan and a new meal has since started
      // another one, the newer plan is the truth: overwriting its id would
      // relabel an unrelated batch as the undone cook's plan.
      if (event.planId && !planId.value) {
        planId.value = event.planId
        planCreatedAt.value = event.planCreatedAt ?? 0
      }
      if (prior.cleared) {
        clearedIngredients.value[prior.entry.variantId] = [...prior.cleared]
      }
    }

    /** Replace the whole plan (used when importing a shared plan). */
    function replacePlan(entries: PlanEntry[], custom: string[] = []): void {
      plan.value = entries.map((e) => ({
        variantId: e.variantId,
        servings: Math.max(1, Math.round(e.servings)),
      }))
      customItems.value = custom
      // A wholesale replacement IS a new plan (Auto-Plan in replace mode,
      // a `?p=` share import, an inbound room snapshot). Keeping the
      // previous identity would file the next cook under a plan this
      // device no longer has — and would publish that stale id to every
      // peer. Mint (or clear) exactly like the empty -> non-empty rule.
      planId.value = ''
      planCreatedAt.value = 0
      if (plan.value.length > 0) ensurePlanIdentity()
    }

    return {
      plan,
      customItems,
      planId,
      planCreatedAt,
      planContains,
      setPlanIdentity,
      ensurePlanIdentity,
      cookPlanIdentity,
      addToPlan,
      removeFromPlan,
      setServings,
      clearPlan,
      addCustomItem,
      removeCustomItem,
      clearCustomItems,
      clearIngredientsForCurrentMeals,
      restoreIngredients,
      setClearedIngredients,
      replaceCookedHistory,
      mergeCookedHistory,
      markCooked,
      unmarkCooked,
      undoMarkCooked,
      isCookedRecently,
      replacePlan,
      cookedHistory,
      clearedIngredients,
    }
  },
  {
    persist: {
      key: 'mealime-planner:v1:plan',
      pick: [
        'plan',
        'planId',
        'planCreatedAt',
        'customItems',
        'cookedHistory',
        'clearedIngredients',
      ],
    },
  },
)