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
 * - Engages only while the page is scrolled to (about) the top and
 *   `enabled` is true (checkedCount > 0).
 * - The gesture OWNS the touch while it is a candidate: a non-passive
 *   `touchmove` listener prevents the browser from turning a downward
 *   drag at the top into a scroll or the native pull-to-refresh. This
 *   is the fix for the real-mobile failure the emulated Pixel 7 e2e
 *   could not see (qodo finding 4 / kody finding, PR #94 round 1): on
 *   Firefox Mobile and Brave the native pan fired `pointercancel`
 *   before `pointerup`, so the armed pull snapped back without
 *   clearing. Only DOWNWARD travel is claimed — an upward drag at the
 *   top must still scroll the list, so `touch-action` stays default and
 *   `overscroll-behavior` on the scrolling root (`html`, style.css)
 *   keeps the browser's own pull-to-refresh out of the way without
 *   breaking scrolling.
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

/**
 * Scroll-top tolerance (px) for the arm decision. Mobile browsers sit a
 * few px off `scrollTop === 0` at the visual list-top (URL-bar / visual
 * viewport offsets), and a strict `=== 0` refused to arm there — the
 * same emulation gap that hid finding 4 from the Pixel 7 e2e.
 */
const SCROLL_TOP_TOLERANCE = 4

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
    const scroller = document.scrollingElement
    const top = scroller ? scroller.scrollTop : window.scrollY
    return top <= SCROLL_TOP_TOLERANCE
  }

  function onPointerDown(e: PointerEvent): void {
    if (e.pointerType !== 'touch') return
    // One gesture at a time (qodo finding 3): a second finger while a
    // pull is pending or engaged must not hijack or reset the first.
    if (activePointerId !== null) return
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

  function onPointerCancel(e: PointerEvent): void {
    // Only the ACTIVE pointer's cancel may end the pull (qodo finding 3):
    // a second finger's cancel must not abort the first finger's gesture.
    if (activePointerId === null || e.pointerId !== activePointerId) return
    release()
  }

  /**
   * The gesture's claim on the touch (the finding-4 fix): while a touch
   * that ARMED at the top is pending or engaged, any DOWNWARD travel is
   * prevented from becoming a native scroll / pull-to-refresh, so the
   * pointer stream survives to `pointerup` instead of dying in a
   * `pointercancel`. Upward travel is left to the browser — scrolling
   * the list from the top must keep working whenever nothing is pulled.
   */
  function onTouchMove(e: TouchEvent): void {
    if (activePointerId === null) return
    if (e.touches.length !== 1) return
    if (e.touches[0]!.clientY - startY > 0) e.preventDefault()
  }

  function attach(el: HTMLElement | null, prev: HTMLElement | null | undefined): void {
    // Detach EVERY listener from the previous element (qodo finding 6 /
    // kody): `pointermove`/`pointerup`/`pointercancel`/`touchmove` left
    // behind kept three-to-four closures — and the composable's state —
    // alive on a replaced or unmounted region.
    prev?.removeEventListener('pointerdown', onPointerDown)
    prev?.removeEventListener('pointermove', onPointerMove)
    prev?.removeEventListener('pointerup', onPointerUp)
    prev?.removeEventListener('pointercancel', onPointerCancel)
    prev?.removeEventListener('touchmove', onTouchMove)
    el?.addEventListener('pointerdown', onPointerDown)
    el?.addEventListener('pointermove', onPointerMove)
    el?.addEventListener('pointerup', onPointerUp)
    el?.addEventListener('pointercancel', onPointerCancel)
    // Non-passive BY CONTRACT: the handler calls preventDefault() to
    // claim downward drags (the finding-4 fix). Passive would make the
    // preventDefault a silent no-op.
    el?.addEventListener('touchmove', onTouchMove, { passive: false })
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
