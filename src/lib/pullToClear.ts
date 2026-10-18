/**
 * Pull-to-clear gesture math (ADR-0092) — PURE, so the threshold and
 * resistance contracts are unit-testable without a DOM.
 *
 * The gesture: while the list is scrolled to the top and at least one
 * item is checked, dragging down translates the list content with the
 * finger (rubber-band resistance). Releasing at or past the threshold
 * runs the shared clear-checked action; releasing below it animates
 * back and does nothing. The button is the desktop affordance; the
 * gesture is touch-pointer-only (ADR-0092 decision 2).
 */

/**
 * Finger travel (px) past which a release ARMS the clear. The ADR pins
 * ~80px; e2e and the composable both read this constant — never re-spell
 * the number.
 */
export const PULL_CLEAR_THRESHOLD = 80

/**
 * Finger travel (px) before the gesture engages at all — the same slop
 * idea scrollviews use, so a tap or micro-jitter at the top of the list
 * never flashes the indicator.
 */
export const PULL_SLOP = 8

/**
 * Resistance curve: the content follows the finger but progressively
 * heavier, the iOS rubber-band shape. `translate(dy)` is 0 for dy <= 0,
 * roughly dy/2 at small pulls, and saturates toward `2 * threshold` —
 * so the content NEVER runs away and the armed state is reached by
 * FINGER travel (`dy >= threshold`), not by pixel-matching the
 * translate, which the curve can asymptotically deny.
 */
export function pullTranslate(dy: number, threshold: number = PULL_CLEAR_THRESHOLD): number {
  if (dy <= 0) return 0
  const c = threshold * 2
  return Math.round((c * dy) / (c + dy))
}

/** The gesture's visual state machine over one pointer drag. */
export type PullPhase = 'idle' | 'pull' | 'armed'

/**
 * Phase for a finger at travel `dy`:
 * - not engaged (or within the slop) → `idle`
 * - engaged below the threshold → `pull`
 * - engaged at/over the threshold → `armed` ("Release to clear checked")
 */
export function pullPhase(
  dy: number,
  engaged: boolean,
  threshold: number = PULL_CLEAR_THRESHOLD,
): PullPhase {
  if (!engaged || dy < PULL_SLOP) return 'idle'
  return dy >= threshold ? 'armed' : 'pull'
}
