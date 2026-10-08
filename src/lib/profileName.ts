/**
 * The display-name surface (ADR-0063) — ONE clamp for every writer of a
 * person's name: the identity store's `rename`, the Settings field, AND
 * the relays' `normalizeProfile` (imported through `server/relay-core/`,
 * the same client-lib → relay lockstep as `roomWords.ts`).
 *
 * A name is 1–40 VISIBLE characters: control and format characters
 * (Unicode category C, which includes zero-width and bidi marks) are
 * stripped before counting, so an invisible payload cannot smuggle a
 * longer name past the cap or garble a roster row.
 */

/** The relay's cap too — the two ends clamp identically by construction. */
export const MAX_NAME_CHARS = 40

/** A profile-less peer's roster row (an old-version client). */
export const GUEST_NAME = 'Guest'

/**
 * Trim, strip control/format characters, collapse whitespace runs and
 * cap at 40 visible characters (counted in code points, so multi-unit
 * graphemes count honestly). '' when nothing visible remains — callers
 * decide the fallback (the relays use `GUEST_NAME`).
 */
export function sanitizeDisplayName(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  // Whitespace first: line/tab breaks become ordinary spaces (they are
  // visible separation, not invisible payload), THEN the remaining
  // category-C characters — zero-width, bidi, BEL — are stripped, so
  // "Brave\tOtter" reads as "Brave Otter", never "BraveOtter".
  const spaced = raw.replace(/\s+/g, ' ')
  const stripped = spaced.replace(/\p{C}/gu, '')
  return [...stripped.trim()].slice(0, MAX_NAME_CHARS).join('')
}

/**
 * True when `value` parses as a UUID in canonical 8-4-4-4-12 hex form.
 * Deliberately shape-only (any version field): the wire contract is "a
 * UUID-parseable id", and a version check here would refuse a future
 * uuid package's output for no benefit. The relays cannot import the
 * `uuid` package (zero-dep relay) — this regex is the shared check.
 */
export function isUuidShape(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
}
