import { defineStore } from 'pinia'
import { ref } from 'vue'
import { DIET_IDS, type DietId } from '../lib/dietFilter'

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

    /** Replace persisted ui prefs wholesale (backup import). */
    function applySettings(prefs: {
      shareCookedHistory?: boolean
      dietFilters?: DietId[]
      householdRoom?: string
    }): void {
      if (typeof prefs.shareCookedHistory === 'boolean') shareCookedHistory.value = prefs.shareCookedHistory
      if (Array.isArray(prefs.dietFilters)) {
        // Unknown ids are dropped rather than trusted (frozen rule set).
        dietFilters.value = prefs.dietFilters.filter((d): d is DietId => DIET_IDS.includes(d as DietId))
      }
      if (typeof prefs.householdRoom === 'string') setHouseholdRoom(prefs.householdRoom)
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
      toast,
      setCookingStep,
      cookingStep,
      applySettings,
      setHouseholdRoom,
      showToast,
      dismissToast,
    }
  },
  {
    // Only the share/diet/room prefs persist; cookingStepIndex stays
    // session-scoped.
    persist: {
      key: 'mealime-planner:v1:ui',
      pick: ['shareCookedHistory', 'dietFilters', 'householdRoom'],
    },
  },
)