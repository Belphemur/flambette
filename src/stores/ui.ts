import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Component } from 'vue'
import { BookOpen, CalendarDays, History, Settings, ShoppingCart } from 'lucide-vue-next'
import {
  defaultQuickFilters,
  migrateLegacyUiFilters,
  normalizeQuickFilters,
  type QuickFilters,
} from '../lib/quickFilters'
import { isRoomCode, normalizeRoomCode } from '../lib/roomWords'
import { clampSeconds, isStepTimer, type StepTimer } from '../lib/stepTimer'

/** Bottom-nav entries, in display order. `to` is the route path; `icon` is
 *  a Lucide component (WS5), not an emoji or a hand-rolled path — the
 *  five labels keep their measured Pixel 7 fit (ADR-0016). */
export const TABS: { id: string; label: string; icon: Component; to: string }[] = [
  { id: 'recipes', label: 'Recipes', icon: BookOpen, to: '/' },
  { id: 'plan', label: 'Plan', icon: CalendarDays, to: '/plan' },
  { id: 'grocery', label: 'Grocery', icon: ShoppingCart, to: '/grocery' },
  { id: 'history', label: 'History', icon: History, to: '/history' },
  { id: 'settings', label: 'Settings', icon: Settings, to: '/settings' },
]

/** An inline button on a toast (e.g. [Clear] [Cancel]). */
export interface ToastAction {
  label: string
  run: () => void
  /** Explicit test id (default: toast-action-primary/secondary). */
  testId?: string
}

export interface Toast {
  message: string
  /** Inline buttons rendered next to the message. */
  actions?: ToastAction[]
  /** Data-test marker discriminating confirmation kinds (e.g. "added").
   *  Rendered as data-test="added-toast" so specs can target the
   *  ingredient-added confirmation, not just any toast. */
  kind?: string
}

export interface ToastOptions {
  /** Inline buttons rendered next to the message. */
  actions?: ToastAction[]
  /** Auto-dismiss delay in ms (default 2500). */
  duration?: number
  /** Confirmation kind — emits data-test="added-toast" when set. */
  kind?: string
  /**
   * Called exactly once when the toast ends, whatever the cause:
   * timeout, replacement by a newer toast, or dismissToast().
   */
  onDismiss?: () => void
}

/** Auto-Plan ruleset choices (ADR-0027). 'any' imposes no filter. */
export type AutoPlanRuleset = 'dinner' | 'breakfast' | 'dessert' | 'any'
export type AutoPlanMode = 'add' | 'replace'
export const AUTO_PLAN_RULESETS: readonly AutoPlanRuleset[] = [
  'dinner',
  'breakfast',
  'dessert',
  'any',
]

/**
 * UI state not owned by the router: cooking step positions (survive tab
 * switches within a session) and transient toasts. Not persisted.
 *
 * The active tab, open recipe and cooking mode are router-driven now —
 * see src/router.ts.
 */
export const useUiStore = defineStore(
  'ui',
  () => {
    /** Cooking step index, keyed by variant id (survives tab switches). */
    const cookingStepIndex = ref<Record<number, number>>({})
    /**
     * Share cooked history with the live room. ON by default
     * (ADR-0032 supersedes ADR-0011's opt-in): a household wants ONE
     * shared cooking log. The opt-out is real and permanent — a user who
     * turns it off keeps it off. Part of backups.
     */
    const shareCookedHistory = ref(true)
    /**
     * "The history-sharing default has already been applied to this
     * install" (ADR-0032).
     *
     * `shareCookedHistory` is persisted, so an install that has been
     * running the pre-ADR-0032 build carries a `false` that is
     * INDISTINGUISHABLE from "the user never touched it" — the boolean
     * alone cannot say which. This flag is the honest fix: on the first
     * launch after the upgrade the stored value is treated as unset and
     * the new default is adopted, and the flag is written immediately.
     * From then on any toggle the user makes is an explicit choice that
     * no later default change may override.
     */
    const historyShareDefaultMigrated = ref(false)
    /** Auto-Plan settings (ADR-0027): last ruleset choice + mode, and the
     *  rotating seed generation (incremented on every successful
     *  generate). All persisted + carried in backups. */
    const autoPlanRuleset = ref<AutoPlanRuleset>('dinner')
    const autoPlanMode = ref<AutoPlanMode>('add')
    const autoPlanGeneration = ref(0)
    /** Generation a run should use (the stored counter). */
    function nextAutoPlanGeneration(): number {
      return autoPlanGeneration.value
    }
    /** Bump after a successful generate so the next run rotates the seed. */
    function advanceAutoPlanGeneration(): void {
      autoPlanGeneration.value += 1
    }
    /**
     * The unified quick-filter selection (ADR-0027): diet chips, protein
     * chip, cook-time bucket, sort mode and the favourites/PRO toggles in
     * ONE object. Persisted (survives a reload) and carried in the room
     * payload as optional `filters` (ADR-0028), so every household member
     * browses the same slice of the catalog.
     */
    const quickFilters = ref<QuickFilters>(defaultQuickFilters())
    /** Persistent household room code the app auto-joins on start (ADR-0019). */
    const householdRoom = ref('')
    /**
     * Cooking-view step timers (ADR-0020): variant id -> step-VIEW leader
     * index -> timer. Keyed by view (not raw step) because a "Meanwhile"
     * pair is one view and shares one timer. Persisted so a reload
     * mid-cook resumes an honest countdown (remaining + startedAt).
     */
    const stepTimers = ref<Record<number, Record<number, StepTimer>>>({})
    /** Transient toast: plain message, optionally with inline action buttons. */
    const toast = ref<Toast | null>(null)
    let toastTimer: ReturnType<typeof setTimeout> | undefined
    /** Dismissal callback of the toast currently on screen. */
    let onDismiss: (() => void) | undefined

    function setCookingStep(variantId: number, step: number) {
      cookingStepIndex.value[variantId] = step
    }

    function cookingStep(variantId: number): number {
      return cookingStepIndex.value[variantId] ?? 0
    }

    /** The timer of one step view, or undefined when none was set. */
    function stepTimer(variantId: number, viewKey: number): StepTimer | undefined {
      return stepTimers.value[variantId]?.[viewKey]
    }

    /**
     * Set (or restart) the timer of one step view to `seconds`. A running
     * timer stamps `startedAt`, so the countdown survives a reload.
     */
    function setStepTimer(variantId: number, viewKey: number, seconds: number, running: boolean) {
      const forRecipe = { ...(stepTimers.value[variantId] ?? {}) }
      forRecipe[viewKey] = {
        remaining: clampSeconds(seconds),
        running,
        startedAt: running ? Date.now() : null,
      }
      stepTimers.value = { ...stepTimers.value, [variantId]: forRecipe }
    }

    /** Start (or restart) a view's timer for `seconds`. */
    function startStepTimer(variantId: number, viewKey: number, seconds: number) {
      setStepTimer(variantId, viewKey, seconds, true)
    }

    /** Pause a view's timer, freezing the remaining seconds it had. */
    function pauseStepTimer(variantId: number, viewKey: number, remaining: number) {
      setStepTimer(variantId, viewKey, remaining, false)
    }

    /** Drop a view's timer entirely (chip/preset reset). */
    function clearStepTimer(variantId: number, viewKey: number) {
      const forRecipe = { ...(stepTimers.value[variantId] ?? {}) }
      if (!(viewKey in forRecipe)) return
      delete forRecipe[viewKey]
      const next = { ...stepTimers.value }
      if (Object.keys(forRecipe).length === 0) delete next[variantId]
      else next[variantId] = forRecipe
      stepTimers.value = next
    }

    /**
     * Replace persisted ui prefs wholesale (backup import).
     *
     * `quickFilters` accepts the whole unified object; a LEGACY
     * `dietFilters` array (backup written before ADR-0027) is still
     * accepted and folded into the diets half, so an old backup restores
     * the user's diet chips instead of silently dropping them.
     */
    function applySettings(prefs: {
      shareCookedHistory?: boolean
      quickFilters?: unknown
      dietFilters?: unknown
      householdRoom?: string
      stepTimers?: unknown
      autoPlanRuleset?: unknown
      autoPlanMode?: unknown
      autoPlanGeneration?: unknown
    }): void {
      if (typeof prefs.shareCookedHistory === 'boolean') {
        shareCookedHistory.value = prefs.shareCookedHistory
        // A restore that carries the value is an EXPLICIT choice (the
        // dialog says settings are overwritten): the one-time default
        // migration must not re-apply over it on the next launch.
        historyShareDefaultMigrated.value = true
      }
      if (
        typeof prefs.autoPlanRuleset === 'string' &&
        (AUTO_PLAN_RULESETS as readonly string[]).includes(prefs.autoPlanRuleset)
      ) {
        autoPlanRuleset.value = prefs.autoPlanRuleset as AutoPlanRuleset
      }
      if (
        (prefs.autoPlanMode === 'add' || prefs.autoPlanMode === 'replace')
      ) {
        autoPlanMode.value = prefs.autoPlanMode
      }
      if (typeof prefs.autoPlanGeneration === 'number' && Number.isFinite(prefs.autoPlanGeneration) && prefs.autoPlanGeneration >= 0) {
        autoPlanGeneration.value = Math.floor(prefs.autoPlanGeneration)
      }
      const filters =
        normalizeQuickFilters(prefs.quickFilters) ??
        (Array.isArray(prefs.quickFilters)
          ? normalizeQuickFilters({ diets: prefs.quickFilters })
          : null) ??
        (Array.isArray(prefs.dietFilters) ? normalizeQuickFilters({ diets: prefs.dietFilters }) : null)
      if (filters) quickFilters.value = filters
      if (typeof prefs.householdRoom === 'string') setHouseholdRoom(prefs.householdRoom)
      if (prefs.stepTimers !== undefined) stepTimers.value = sanitizeStepTimers(prefs.stepTimers)
    }

    /**
     * Seed the unified filters from state persisted before ADR-0027 (a
     * v0.12 localStorage blob holds `dietFilters` and no `quickFilters`),
     * and repair anything the hydrated value got wrong.
     *
     * Runs once, after persistence hydration. Hydration is a raw
     * `$patch` of whatever was in localStorage, so a hand-edited,
     * half-written or older-build value reaches the store verbatim;
     * without this the Recipes tab would read a malformed `diets` array
     * and could fail while iterating it. A non-object (or a legacy
     * `dietFilters` array) falls back to the migration, then to defaults.
     */
    function migrateLegacyFilters(): void {
      let raw: string | null = null
      try {
        raw = localStorage.getItem('mealime-planner:v1:ui')
      } catch {
        return // storage unavailable: nothing to migrate
      }
      const migrated = migrateLegacyUiFilters(raw)
      if (migrated) {
        quickFilters.value = migrated
        return
      }
      const normalized = normalizeQuickFilters(quickFilters.value)
      if (normalized) quickFilters.value = normalized
      else quickFilters.value = defaultQuickFilters()
    }

    /**
     * Apply the ADR-0032 default (sharing ON) to a pre-ADR-0032 install,
     * and mark EVERY install as migrated so the default can never re-run.
     *
     * Called from `afterHydrate`: at that point the persisted blob has loaded,
     * so we can inspect what actually landed. Two cases:
     *
     * - **Pre-ADR-0032 install**: the blob carries `shareCookedHistory: false`
     *   (the old default) and NO `historyShareDefaultMigrated` flag. We adopt
     *   ON — the owner ruled that a silent `false` is not a user choice.
     *
     * - **Fresh install**: nothing has been toggled, so the persisted blob has
     *   NEITHER key. We leave `shareCookedHistory` at its in-memory default
     *   (`true` from the `ref(true)`) untouched — there is no `false` to
     *   override — and mark migrated so a later opt-OUT is honoured.
     *
     * That split is the whole fix for the bug where a fresh install that
     * opted out before the first reload re-awakened sharing on the next
     * hydrate: the old version ran the default unconditionally whenever
     * `migrated` was false, and a fresh install looks identical to a legacy
     * blob at that point.
     */
    function adoptHistoryShareDefault(): void {
      if (historyShareDefaultMigrated.value) return

      let hasLegacyBlob = false
      try {
        const raw = localStorage.getItem('mealime-planner:v1:ui')
        if (raw) {
          const blob = JSON.parse(raw) as Record<string, unknown>
          hasLegacyBlob =
            Object.prototype.hasOwnProperty.call(blob, 'shareCookedHistory') &&
            !Object.prototype.hasOwnProperty.call(blob, 'historyShareDefaultMigrated')
        }
      } catch {
        hasLegacyBlob = true // unreadable blob: adopt the default once
      }

      if (hasLegacyBlob) shareCookedHistory.value = true
      historyShareDefaultMigrated.value = true
    }

    /**
     * Keep only well-formed timers out of an imported/loaded map
     * (validation-first import: unknown shapes are dropped, not trusted).
     */
    function sanitizeStepTimers(value: unknown): Record<number, Record<number, StepTimer>> {
      const out: Record<number, Record<number, StepTimer>> = {}
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return out
      for (const [variantRaw, viewsRaw] of Object.entries(value as Record<string, unknown>)) {
        if (!/^\d+$/.test(variantRaw)) continue
        if (typeof viewsRaw !== 'object' || viewsRaw === null || Array.isArray(viewsRaw)) continue
        const views: Record<number, StepTimer> = {}
        for (const [viewRaw, timer] of Object.entries(viewsRaw as Record<string, unknown>)) {
          if (!/^\d+$/.test(viewRaw) || !isStepTimer(timer)) continue
          views[Number(viewRaw)] = {
            remaining: clampSeconds(timer.remaining),
            running: timer.running,
            startedAt: timer.startedAt === null ? null : timer.startedAt,
          }
        }
        if (Object.keys(views).length > 0) out[Number(variantRaw)] = views
      }
      return out
    }

    /**
     * Persist (or clear) the household room code (ADR-0021).
     *
     * Input is normalized to canonical form — three hyphenated lowercase
     * words (`amber-falcon-lantern`) or a legacy 4–12 char uppercase
     * alphanumeric code, both still accepted (ADR-0019 households).
     * Anything else clears the setting rather than storing a code that
     * can never join.
     */
    function setHouseholdRoom(code: string) {
      const normalized = normalizeRoomCode(code)
      householdRoom.value = isRoomCode(normalized) ? normalized : ''
    }

    /** End the current toast (if any) and fire its onDismiss exactly once. */
    function endToast() {
      if (toastTimer) {
        clearTimeout(toastTimer)
        toastTimer = undefined
      }
      const cb = onDismiss
      onDismiss = undefined
      toast.value = null
      cb?.()
    }

    function showToast(message: string, options: ToastOptions = {}) {
      // A replacing toast ends the previous one first (its onDismiss fires).
      endToast()
      onDismiss = options.onDismiss
      toast.value = { message, actions: options.actions, kind: options.kind }
      toastTimer = setTimeout(endToast, options.duration ?? 2500)
    }

    /** Dismiss the current toast immediately (e.g. the Cancel button). */
    function dismissToast() {
      endToast()
    }

    return {
      cookingStepIndex,
      shareCookedHistory,
      historyShareDefaultMigrated,
      quickFilters,
      householdRoom,
      stepTimers,
      toast,
      autoPlanRuleset,
      autoPlanMode,
      autoPlanGeneration,
      nextAutoPlanGeneration,
      advanceAutoPlanGeneration,
      setCookingStep,
      cookingStep,
      stepTimer,
      setStepTimer,
      startStepTimer,
      pauseStepTimer,
      clearStepTimer,
      applySettings,
      migrateLegacyFilters,
      adoptHistoryShareDefault,
      setHouseholdRoom,
      showToast,
      dismissToast,
    }
  },
  {
    // The quick filters (ADR-0027), the share/room prefs and the step
    // timers (ADR-0020, so a reload mid-cook resumes honestly) persist;
    // cookingStepIndex stays session-scoped.
    persist: {
      key: 'mealime-planner:v1:ui',
      pick: [
        'shareCookedHistory',
        // Not a setting: the once-only marker for ADR-0032's default
        // migration. Persisted so the migration cannot run twice on a
        // genuinely pre-ADR-0032 install. It is set to TRUE on first launch
        // of this build for EVERY install (fresh or migrated), so that a
        // fresh install that has not opted out is never mistaken for a
        // legacy blob and never has its toggle reset back to the default
        // (issue: opt-out on a fresh install was re-enabled after reload).
        'historyShareDefaultMigrated',
        'quickFilters',
        'householdRoom',
        'stepTimers',
        'autoPlanRuleset',
        'autoPlanMode',
        'autoPlanGeneration',
      ],
      // Hydration has already run when this fires, so a v0.12 blob (which
      // has no `quickFilters` and therefore patched nothing) can still be
      // migrated from its legacy `dietFilters` array — and a pre-ADR-0032
      // blob can still have the new history default applied to it.
      afterHydrate: (context) => {
        const store = context.store as unknown as {
          migrateLegacyFilters: () => void
          adoptHistoryShareDefault: () => void
        }
        store.migrateLegacyFilters()
        store.adoptHistoryShareDefault()
      },
    },
  },
)