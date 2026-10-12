import { ref, watch, type Ref } from 'vue'
import { getTimerHints, hintForStep, type TimerHint } from '../lib/timerSuggest'

/**
 * The timer-hint sidecar loader, ONE owner (ADR-0041): RecipeDetail and
 * CookingView used to hand-copy the same watch — reset on id change,
 * fetch, and let only the CURRENT recipe's load win. The stale-fetch
 * guard is the load-bearing part: a fetch that resolves after the reader
 * moved on must never paint the other recipe's hints.
 *
 * Pass the id as a reactive getter (`() => props.meta?.id`); undefined
 * clears. Returns the hints ref plus a hint-lookup bound to it.
 */
export function useTimerHints(id: () => number | undefined): {
  hints: Ref<TimerHint[] | null>
  hintAt: (indices: number[]) => TimerHint | null
} {
  const hints = ref<TimerHint[] | null>(null)
  watch(
    id,
    (value) => {
      hints.value = null
      if (value === undefined) return
      void getTimerHints(value).then((loaded) => {
        // A stale fetch (the reader moved to another recipe) never wins.
        if (id() === value) hints.value = loaded
      })
    },
    { immediate: true },
  )
  return {
    hints,
    hintAt: (indices) => (hints.value ? hintForStep(hints.value, indices) : null),
  }
}
