import { defineStore } from 'pinia'
import { ref } from 'vue'

/** Bottom-nav entries, in display order. `to` is the route path. */
export const TABS: { id: string; label: string; icon: string; to: string }[] = [
  { id: 'recipes', label: 'Recipes', icon: '📖', to: '/' },
  { id: 'plan', label: 'Plan', icon: '📅', to: '/plan' },
  { id: 'grocery', label: 'Grocery', icon: '🛒', to: '/grocery' },
  { id: 'history', label: 'History', icon: '🕓', to: '/history' },
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
}

export interface ToastOptions {
  /** Inline buttons rendered next to the message. */
  actions?: ToastAction[]
  /** Auto-dismiss delay in ms (default 2500). */
  duration?: number
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
      toast.value = { message, actions: options.actions }
      toastTimer = setTimeout(endToast, options.duration ?? 2500)
    }

    /** Dismiss the current toast immediately (e.g. the Cancel button). */
    function dismissToast() {
      endToast()
    }

    return {
      cookingStepIndex,
      toast,
      setCookingStep,
      cookingStep,
      showToast,
      dismissToast,
    }
  },
)