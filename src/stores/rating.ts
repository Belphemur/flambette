import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * Per-recipe household ratings (ADR-0031).
 *
 * A rating is OPINION, never catalog truth: `variant_meta.rating` stays a
 * read-only catalog signal and is deliberately NOT copied in here. The
 * store therefore seeds EMPTY — unlike the favourites store, which seeds
 * from the user's own Mealime snapshot.
 *
 * Shape: a plain `Record<variantId, RatingRecord>`. A record (not a Map)
 * so it serializes as-is, round-trips through the backup registry
 * (`ratings.json`) and can be reconciled key-wise in one pass when a room
 * snapshot arrives — see `mergeRemote` and src/stores/room.ts.
 *
 * RECONCILIATION (ADR-0031): every record carries `updatedAt`, and a
 * merge adopts the incoming record for a recipe only when it is strictly
 * NEWER. That is per-record last-writer-wins, deliberately NOT the room's
 * whole-state LWW — two peers rating different recipes is the normal case,
 * and a wholesale replace would let whoever pushed last erase the rest.
 */

/** A recipe's household rating, as stored, synced and backed up. */
export interface RatingRecord {
  /** Star value in 0.5 steps, 0..5. */
  rating: number
  /** How many distinct ratings the value summarises (household size). */
  count: number
  /** Unix ms of the last write that produced this record. The merge key. */
  updatedAt: number
}

/** variantId → rating. Keys are numeric variant ids, as strings in JSON. */
export type RatingsMap = Record<string, RatingRecord>

/** One row of `ratings.json` — the id travels with the record. */
export interface RatingFileRow extends RatingRecord {
  id: number
}

/** Snap a UI value (0.5 steps) into the stored 0..5 half-star grid. */
export function normalizeStarValue(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(5, Math.max(0, Math.round(value * 2) / 2))
}

/** A timestamp must be a finite, non-negative number of ms. */
function normalizeStamp(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/**
 * How far AHEAD of our own clock an inbound stamp may sit before we stop
 * trusting it. Clock skew between two phones on a LAN is seconds, not
 * hours — but a peer (or a hand-edited file) claiming a timestamp far in
 * the future would pin that recipe's rating forever: every later, honest
 * write looks "older" and is discarded. Clamping keeps a skewed peer
 * usable and bounds the damage of a bogus one.
 */
const MAX_FUTURE_SKEW_MS = 60 * 60 * 1000

/** Clamp an untrusted stamp into "plausible" territory. */
function clampStamp(stamp: number, now: number): number {
  return Math.min(stamp, now + MAX_FUTURE_SKEW_MS)
}

/** Map → the ratings.json row array. */
export function ratingsToRows(map: Readonly<RatingsMap>): RatingFileRow[] {
  return Object.entries(map)
    .map(([id, entry]) => ({ id: Number(id), ...entry }))
    .filter((row) => Number.isFinite(row.id))
    .sort((a, b) => a.id - b.id)
}

/** Sanitize an untrusted ratings payload (room peer, backup file). */
export function sanitizeRatings(value: unknown): RatingsMap {
  const out: RatingsMap = {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return out
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!/^\d+$/.test(key)) continue
    if (typeof entry !== 'object' || entry === null) continue
    const { rating, count, updatedAt } = entry as Partial<RatingRecord>
    const stars = normalizeStarValue(Number(rating))
    // 0 means "unrated" and is never stored (see setRating).
    if (stars <= 0) continue
    out[key] = {
      rating: stars,
      count: Number.isFinite(count) ? Math.max(1, Math.floor(Number(count))) : 1,
      updatedAt: clampStamp(normalizeStamp(updatedAt, 0), Date.now()),
    }
  }
  return out
}

export const useRatingStore = defineStore(
  'ratings',
  () => {
    /** variantId → household rating. Reactive: the star widgets read it. */
    const map = ref<RatingsMap>({})

    /** Household rating for a recipe, or 0 when nobody rated it. */
    function ratingFor(variantId: number): number {
      return map.value[String(variantId)]?.rating ?? 0
    }

    /** How many ratings the household has cast for a recipe (0 = never). */
    function countFor(variantId: number): number {
      return map.value[String(variantId)]?.count ?? 0
    }

    /** When the local record for a recipe was last written (0 = never). */
    function updatedAtFor(variantId: number): number {
      return map.value[String(variantId)]?.updatedAt ?? 0
    }

    /**
     * Record a rating, stamped with the time of the write.
     *
     * `updatedAt` is injectable so the reconciliation rules are testable
     * with deterministic clocks (e2e/unit) instead of sleeping; production
     * callers pass nothing and get `Date.now()`.
     *
     * Re-rating a recipe from THIS device REPLACES the value and keeps the
     * count: the count is a household-size signal for smoothing, and one
     * person changing their mind must not inflate it. (`count` tracks the
     * votes KNOWN to the record — see `mergeRemote` for why it is not
     * incremented on receive.)
     */
    function setRating(variantId: number, value: number, updatedAt: number = Date.now()): void {
      const rating = normalizeStarValue(value)
      const key = String(variantId)
      const stamp = normalizeStamp(updatedAt, Date.now())
      if (rating <= 0) {
        if (!(key in map.value)) return
        const next = { ...map.value }
        delete next[key]
        map.value = next
        return
      }
      map.value = {
        ...map.value,
        [key]: { rating, count: map.value[key]?.count ?? 1, updatedAt: stamp },
      }
    }

    /**
     * Reconcile a peer's ratings: PER-RECORD last-writer-wins by
     * `updatedAt`, adopted VERBATIM. Never a wholesale replace (ADR-0031)
     * — a peer that rated one recipe must not erase the rest.
     *
     * The incoming `count` is taken as-is, NOT incremented. An increment
     * here is not idempotent under replay: the author already counted its
     * own vote when it wrote the record, so adding one on every receive
     * would inflate the count, and two peers receiving the same record
     * would end up with different counts — the smoothing weight would
     * drift apart from recipe to recipe and from device to device.
     * Verbatim adoption is the only rule under which every peer holding
     * the newest record for a recipe agrees on it.
     */
    function mergeRemote(incoming: unknown): void {
      const clean = sanitizeRatings(incoming)
      if (Object.keys(clean).length === 0) return
      const next = { ...map.value }
      for (const [key, record] of Object.entries(clean)) {
        const local = next[key]
        if (local && record.updatedAt <= local.updatedAt) continue
        next[key] = record
      }
      map.value = next
    }

    return { map, ratingFor, countFor, updatedAtFor, setRating, mergeRemote }
  },
  {
    // A plain record round-trips through JSON untouched — no custom
    // serializer needed (unlike the favourites store's Set).
    persist: { key: 'mealime-planner:v1:ratings', pick: ['map'] },
  },
)
