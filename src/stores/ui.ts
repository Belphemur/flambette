import { defineStore } from 'pinia'
import { ref } from 'vue'
import { DIET_IDS, type DietId } from '../lib/dietFilter'
import { clampSeconds, isStepTimer, type StepTimer } from '../lib/stepTimer'

/** Bottom-nav entries, in display order. `to` is the route path. */
export const TABS: { id: string; label: string; icon: string; to: string }[] = [
  { id: 'recipes', label: 'Recipes', icon: '📖', to: '/' },
  { id: 'plan', label: 'Plan', icon: '📅', to: '/plan' },
  { id: 'grocery', label: 'Grocery', icon: '🛒', to: '/grocery' },
  { id: 'history', label: 'History', icon: '🕓', to: '/history' },
  { id: 'settings', label: 'Settings', icon: '⚙️', to: '/settings' },
]

/** An inline button on a toast (e.g. [Clear] [Cancel]). */
export interface ToastAction {
  label: string
  run: () => void
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
    /** Share personal cooked history with the live room (off by default —
     *  history is personal data; see ADR-0011 addendum). Part of backups. */
    const shareCookedHistory = ref(false)
    /** Active diet-filter chips on the Recipes tab (AND, ADR-0018). */
    const dietFilters = ref<DietId[]>([])
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

    /** Replace persisted ui prefs wholesale (backup import). */
    function applySettings(prefs: {
      shareCookedHistory?: boolean
      dietFilters?: DietId[]
      householdRoom?: string
      stepTimers?: unknown
    }): void {
      if (typeof prefs.shareCookedHistory === 'boolean') shareCookedHistory.value = prefs.shareCookedHistory
      if (Array.isArray(prefs.dietFilters)) {
        // Unknown ids are dropped rather than trusted (frozen rule set).
        dietFilters.value = prefs.dietFilters.filter((d): d is DietId => DIET_IDS.includes(d as DietId))
      }
      if (typeof prefs.householdRoom === 'string') setHouseholdRoom(prefs.householdRoom)
      if (prefs.stepTimers !== undefined) stepTimers.value = sanitizeStepTimers(prefs.stepTimers)
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
     * Persist (or clear) the household room code. Normalized to upper
     * case; anything that is not a plausible code clears the setting.
     */
    function setHouseholdRoom(code: string) {
      const cleaned = code.trim().toUpperCase()
      householdRoom.value = /^[A-Z0-9]{4,12}$/.test(cleaned) ? cleaned : ''
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
      dietFilters,
      householdRoom,
      stepTimers,
      toast,
      setCookingStep,
      cookingStep,
      stepTimer,
      setStepTimer,
      startStepTimer,
      pauseStepTimer,
      clearStepTimer,
      applySettings,
      setHouseholdRoom,
      showToast,
      dismissToast,
    }
  },
  {
    // Only the share/diet/room prefs + step timers persist (ADR-0020, so a
    // reload mid-cook resumes honestly); cookingStepIndex stays
    // session-scoped.
    persist: {
      key: 'mealime-planner:v1:ui',
      pick: ['shareCookedHistory', 'dietFilters', 'householdRoom', 'stepTimers'],
    },
  },
)