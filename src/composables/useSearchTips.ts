/**
 * The search-tips disclosure state (ADR-0070 Addendum 1 & 2).
 *
 * ONE module-scope ref, read by the two places that can open the tips:
 * the header's `?` affordance (which rides the persistent search well on
 * every tab at `lg:`) and the Recipes tab's own toggle. The PANEL itself
 * stays content-level and mounts with the Recipes tab — a disclosure is
 * not part of the field component, and its closed-by-default,
 * device-local nature is unchanged.
 *
 * A module singleton rather than a store member on purpose: the tips are
 * not a household preference (ADR-0027's search-is-not-a-preference rule
 * applies to the disclosure too), so this state is never persisted and
 * never travels in the room payload.
 */

import { ref } from 'vue'

/** Is the search-tips panel open? Closed by default everywhere. */
const showTips = ref(false)

export function useSearchTips() {
  function toggleTips(): void {
    showTips.value = !showTips.value
  }

  function closeTips(): void {
    showTips.value = false
  }

  return { showTips, toggleTips, closeTips }
}
