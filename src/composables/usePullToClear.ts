import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import {
  PULL_CLEAR_THRESHOLD,
  PULL_SLOP,
  pullPhase,
  pullTranslate,
  type PullPhase,
} from '../lib/pullToClear'

/**
 * Pull-to-clear gesture wiring (ADR-0092) — ONE implementation consumed
 * by BOTH the Grocery tab and Shop view through PullToClearRegion; views
 * never re-spell the pointer logic (the ADR-0003 rule).
 *
 * Contract:
 * - TOUCH pointers only. A mouse drag must never engage (the button is
 *   the desktop affordance).
 * - Engages only while the page is scrolled to the top (`window.scrollY
 *   === 0`) and `enabled` is true (checkedCount > 0). Native scrolling
 *   is never blocked: touch-action stays default, and at scrollTop 0 a
 *   downward drag has nothing to scroll anyway — `overscroll-behavior`
 *   on the region keeps the browser's own pull-to-refresh out of the
 *   way.
 * - The content translates with the finger through the rubber-band
 *   curve; releasing at/over the threshold fires `onTrigger` (the SHARED
 *   clear-checked action), releasing below it only animates back.
 */
export interface PullToClearOptions {
  /** Whether the gesture may arm at all (checkedCount > 0). */
  enabled: Ref<boolean>
  /** Runs the shared clear-checked action on a release past threshold. */
  onTrigger: () => void
  /** Override for tests; defaults to ADR-0092's ~80px. */
  threshold?: number
}

/** Transition (ms) for the snap-back after a release. */
const SETTLE_MS = 200

export function usePullToClear(options: PullToClearOptions) {
  const threshold = options.threshold ?? PULL_CLEAR_THRESHOLD

  /** The region element pointer events attach to (bound by the view). */
  const rootEl = ref<HTMLElement | null>(null)

  /** Current translated distance in px (0 = rest). */
  const pullPx = ref(0)
  const phase = ref<PullPhase>('idle')
  /** True only while the snap-back transition runs. */
  const settling = ref(false)

  let activePointerId: number | null = null
  let startY = 0
  let engaged = false
  let settleTimer: ReturnType<typeof setTimeout> | undefined

  function atTop(): boolean {
    return window.scrollY <= 0
  }

  function onPointerDown(e: PointerEvent): void {
    if (e.pointerType !== 'touch') return
    if (!options.enabled.value || !atTop()) return
    activePointerId = e.pointerId
    startY = e.clientY
    engaged = false
  }

  function onPointerMove(e: PointerEvent): void {
    if (activePointerId === null || e.pointerId !== activePointerId) return
    const dy = e.clientY - startY
    if (!engaged) {
      if (dy < PULL_SLOP) return
      if (!atTop()) {
        // The page scrolled since the touch began — this is a scroll, not
        // a pull. Stand down quietly.
        activePointerId = null
        return
      }
      engaged = true
      // Own the pointer through the whole gesture so moves keep arriving
      // even if the finger leaves the region.
      try {
        rootEl.value?.setPointerCapture(e.pointerId)
      } catch {
        // A lost capture is not fatal: moves still reach us while the
        // finger stays inside the region.
      }
    }
    pullPx.value = pullTranslate(dy, threshold)
    phase.value = pullPhase(dy, true, threshold)
  }

  function release(): void {
    activePointerId = null
    engaged = false
    pullPx.value = 0
    phase.value = 'idle'
    settling.value = true
    if (settleTimer) clearTimeout(settleTimer)
    settleTimer = setTimeout(() => {
      settling.value = false
    }, SETTLE_MS)
  }

  function onPointerUp(e: PointerEvent): void {
    if (activePointerId === null || e.pointerId !== activePointerId) return
    const armed = phase.value === 'armed'
    release()
    if (armed) options.onTrigger()
  }

  function onPointerCancel(): void {
    if (activePointerId === null) return
    release()
  }

  function attach(el: HTMLElement | null, prev: HTMLElement | null | undefined): void {
    prev?.removeEventListener('pointerdown', onPointerDown)
    el?.addEventListener('pointerdown', onPointerDown)
    el?.addEventListener('pointermove', onPointerMove)
    el?.addEventListener('pointerup', onPointerUp)
    el?.addEventListener('pointercancel', onPointerCancel)
  }

  /**
   * Function template ref (`:ref="bindRoot"`) — the typed-ref form the
   * repo standardizes on; a plain string `ref` leaves the composable's
   * ref unread and vue-tsc flags TS6133.
   */
  function bindRoot(el: unknown): void {
    const next = (el as HTMLElement | null) ?? null
    if (next !== rootEl.value) rootEl.value = next
  }

  watch(rootEl, attach, { immediate: true, flush: 'post' })

  // The gesture cannot survive its enabler: checked items cleared (by a
  // peer, a cook, a re-plan) mid-drag must not leave a stuck transform.
  watch(options.enabled, (on) => {
    if (!on && activePointerId !== null) release()
  })

  onBeforeUnmount(() => {
    attach(null, rootEl.value)
    if (settleTimer) clearTimeout(settleTimer)
  })

  /**
   * Style for the translating content: the transform while dragging, a
   * short ease-out ONLY for the snap-back (a transition during the drag
   * would lag the finger).
   */
  const contentStyle = computed(() => ({
    transform: `translateY(${pullPx.value}px)`,
    transition: settling.value ? `transform ${SETTLE_MS}ms ease-out` : 'none',
  }))

  return { bindRoot, pullPx, phase, contentStyle }
}
