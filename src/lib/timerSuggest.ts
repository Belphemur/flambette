/**
 * Recipe-detected timer suggestions (ADR-0041).
 *
 * The suggestions are extracted OFFLINE by `scripts/extract_timer_hints.py`
 * into a sidecar next to each recipe doc —
 * `public/data/recipes/<variantId>.timer.json` — shaped
 * `{ steps: [{ step, seconds, label?, range? }] }`. This lib is a pure
 * LOOKUP over that artifact, loaded ON DEMAND only for the variant being
 * read and cached per session (the same lazy pattern as the catalog doc):
 * no global index fetch, and recipes without a sidecar (no authored
 * durations) resolve to no suggestions at all.
 *
 * The hard rule stays ADR-0022's: NOTHING is ever fabricated. The
 * extractor only reports durations literally written in the authored
 * text; a missing sidecar or step is a missed chip, and a found one is
 * still confirmed by the user before anything is armed (§4).
 */

import { MAX_TIMER_LABEL, clampSeconds } from './stepTimer'

export interface TimerHint {
  /** 0-based instruction index the hint belongs to. */
  step: number
  /** Suggested duration in seconds — the LOWER bound of an authored range. */
  seconds: number
  /** The food the sentence named, else the extractor's "Step N" fallback. */
  label?: string
  /** The authored range's BOTH bounds, in seconds. */
  range?: [number, number]
}

export interface TimerHintsDoc {
  steps: TimerHint[]
}

export interface TimerSuggestion {
  /** Chip label: the food or "Step N", with the range disclosed when it fits. */
  label: string
  /** Suggested minutes — the LOWER bound when the text is a range. */
  minutes: number
  /** `minutes` as clamped seconds, ready for the countdown engine. */
  seconds: number
  /** The authored range, in MINUTES ("20–25"), when one was authored. */
  range?: string
  /** The authored lower bound in seconds — provenance for the confirm. */
  secondsLow: number
}

/* ---------- On-demand sidecar loading (cached per session) ---------- */

const BASE = import.meta.env?.BASE_URL ?? '/'

const cache = new Map<number, Promise<TimerHint[]>>()

/**
 * The hints of ONE variant, fetched on demand from its sidecar. A missing
 * sidecar (recipes with zero hints have none) resolves to an EMPTY list —
 * a 404 is a fact about the catalog, not an error.
 */
export function getTimerHints(variantId: number): Promise<TimerHint[]> {
  let p = cache.get(variantId)
  if (!p) {
    p = fetch(`${BASE}data/recipes/${variantId}.timer.json`)
      .then((res) => (res.ok ? (res.json() as Promise<TimerHintsDoc>) : { steps: [] }))
      .then((doc) => (Array.isArray(doc?.steps) ? doc.steps : []))
      .catch(() => [])
    cache.set(variantId, p)
  }
  return p
}

/* ---------- Pure lookup over the loaded hints ---------- */

/**
 * The hint for the step view on screen. `stepIndices` are the 0-based
 * instruction indexes of the CURRENT view in display order — the view's
 * leader first, because a Meanwhile pair (ADR-0010) is ONE view whose
 * suggestion belongs to whichever step wrote a duration first.
 */
export function hintForStep(hints: readonly TimerHint[], stepIndices: readonly number[]): TimerHint | null {
  for (const index of stepIndices) {
    const hint = hints.find((h) => h && h.step === index)
    if (hint) return hint
  }
  return null
}

/** `20–25` for a range in minutes, undefined for a single authored value. */
function rangeText(range: readonly [number, number] | undefined): string | undefined {
  if (!range) return undefined
  const lo = range[0] / 60
  const hi = range[1] / 60
  return `${fmtMinutes(lo)}–${fmtMinutes(hi)}`
}

/** Whole minutes plain ("15"), fractional minutes with one decimal ("1.5"). */
function fmtMinutes(m: number): string {
  const rounded = Math.round(m * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : String(rounded)
}

/**
 * The suggestion the confirm pre-fills, derived from one hint. The label
 * discloses the range next to the name ("Rice (of 20–25)") when it fits
 * the chip budget — the ARMED value is the lower bound, so saying so keeps
 * the chip from reading like a claim about the whole range. Otherwise the
 * bare label and the range stays in the confirm's minutes text.
 */
export function suggestionFromHint(hint: TimerHint): TimerSuggestion {
  const secondsLow = clampSeconds(hint.seconds)
  const minutes = Math.round((secondsLow / 60) * 10) / 10
  const base = hint.label || 'Step'
  const range = rangeText(hint.range)
  let label = base
  if (range) {
    const withRange = `${base} (of ${range})`
    if (withRange.length <= MAX_TIMER_LABEL) label = withRange
  }
  return {
    label,
    minutes,
    seconds: secondsLow,
    ...(range === undefined ? {} : { range }),
    secondsLow,
  }
}
