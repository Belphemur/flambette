/**
 * The remembered default serving size (ADR-0037).
 *
 * Every recipe in the frozen catalog is authored `serving_count = 6`, so
 * "6" was the app's hardcoded starting point on every surface: the detail
 * sheet, Auto-Plan, the History re-plan and an unplanned cook. That is a
 * recipe fact being used as a HOUSEHOLD fact — a family of four that
 * scales down to 4 once had to scale back up by hand every time, on every
 * surface, forever.
 *
 * The fix is a remembered default: whatever the user last chose becomes the
 * next starting point. This module is the PURE part of that — one clamp,
 * shared by the store, the components and the backup validator, so no
 * surface can invent its own bound and a hand-edited persisted value can
 * never reach a `factor` computation.
 *
 * Device-local, on purpose: it is a personal convenience, not household
 * state. The PLAN's servings are what sync across the room; a default that
 * followed one phone's cook onto another would silently re-scale recipes
 * this household already agreed on.
 */

/**
 * The fallback when nothing has been remembered (a fresh install) and the
 * fallback for any value that is not a usable count. Matches the authored
 * `serving_count` of every catalog recipe, so behaviour is unchanged for
 * an install that never touches the control.
 */
export const FALLBACK_SERVINGS = 6

/** One serving is the floor — the plan store already clamps to it. */
export const MIN_SERVINGS = 1

/**
 * Ceiling for the REMEMBERED default. Deliberately generous: a big-batch
 * cook is a real thing, and the bound exists only so a hand-edited
 * localStorage value (or a runaway `+` press) cannot persist an absurd
 * default that would then scale every future recipe. Well above any
 * household size.
 */
export const MAX_SERVINGS = 99

/**
 * Coerce anything to a usable serving count.
 *
 * Accepts unknown on purpose: this is the single gate every inbound value
 * passes — a persisted blob, a backup `settings.json`, or a number a
 * caller computed. A non-finite, fractional, zero or negative value falls
 * back rather than clamping to 1, because "garbage in" should not read as
 * "the user wants one serving".
 */
export function clampServings(value: unknown, fallback: number = FALLBACK_SERVINGS): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const whole = Math.round(value)
  if (whole < MIN_SERVINGS) return fallback
  if (whole > MAX_SERVINGS) return MAX_SERVINGS
  return whole
}

/**
 * True when `value` is a serving count we would accept as-is. Used by the
 * backup validator, which must REJECT a malformed `settings.json` rather
 * than silently repair it (import is validation-first, ADR-0013).
 */
export function isServings(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= MIN_SERVINGS &&
    value <= MAX_SERVINGS
  )
}
