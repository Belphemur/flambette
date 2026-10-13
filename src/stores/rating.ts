import { defineStore } from 'pinia'
import { ref } from 'vue'
import { clampStamp, mergeLww, normalizeStamp } from '../lib/stamps'

/**
 * variantId → tombstone stamp (ADR-0082). A clear writes one so the
 * deletion can outlive the record it deleted — the room transport
 * publishes `ratings` only when non-empty and `mergeLww` never removes
 * keys, so without a tombstone a clear could never reach peers.
 */
export type RatingTombstones = Record<string, number>

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

/**
 * The rating PRECEDENCE (ADR-0031/0074): the household's own stars when
 * it has one, else the catalog's Bayesian mean (0..1 → 0..5 stars). ONE
 * helper — the card disc, the detail number and the star strip used to
 * spell it three times. Returns the RAW 0..5 star value; callers keep
 * their own rounding/rendering.
 */
export function displayRating(mine: number, catalogRating01: number): number {
  return mine > 0 ? mine : catalogRating01 * 5
}

/**
 * When the star strip's fill is the CATALOG fallback (ADR-0082 addendum):
 * a fill drawn from the Bayesian mean is background information, not the
 * household's opinion, so the clipped fill overlay dims (`opacity-45`).
 * Three conditions, ALL required:
 * - the household has not rated (`mine === 0`) — a committed rating is
 *   always full strength;
 * - a catalog score actually fills the stars (`fallbackRating > 0`) —
 *   with no mean there is no fill to dim (the no-score corner, ADR-0082
 *   addendum: the empty row is the invitation);
 * - nothing is being previewed (`previewing` false) — hover/focus renders
 *   FULL strength so the target stays legible mid-gesture.
 */
export function ratingFillDimmed(
  mine: number,
  fallbackRating01: number,
  previewing: boolean,
): boolean {
  return !previewing && mine === 0 && fallbackRating01 > 0
}

/**
 * The NO-SCORE corner (ADR-0082 addendum): neither the household nor the
 * catalog has any score — `count === 0` and the Bayesian mean is 0 (11 of
 * 2,759 catalog variants ship `rating: 0`). The rate card's helper line
 * then reads "Be the first to rate this recipe" instead of the generic
 * tap hint, and NO number is printed (there is no mean to show — a
 * fabricated prior would violate the no-fictions rule).
 */
export function ratingNoScoreCorner(count: number, catalogRating01: number): boolean {
  return count === 0 && catalogRating01 === 0
}

/** Map → the ratings.json row array. */
export function ratingsToRows(map: Readonly<RatingsMap>): RatingFileRow[] {
  return Object.entries(map)
    .map(([id, entry]) => ({ id: Number(id), ...entry }))
    .filter((row) => Number.isFinite(row.id))
    .sort((a, b) => a.id - b.id)
}

/**
 * Sanitize an untrusted tombstone payload (room peer, backup file) into
 * {numericId: stamp}. An entry that cannot yield a real stamp is DROPPED,
 * never defaulted to 0 — a garbage stamp must never delete a record
 * (deleting on a stamp of 0 would erase every rating a peer ever took).
 * Stamps are clamped like every timestamp (stamps.ts): a tombstone that
 * claims a decade from now would delete honest future writes too.
 */
export function sanitizeTombstones(value: unknown): RatingTombstones {
  const out: RatingTombstones = {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return out
  for (const [key, stamp] of Object.entries(value as Record<string, unknown>)) {
    if (!/^\d+$/.test(key)) continue
    // STRICT numeric: a numeric STRING is malformed on this wire, not a
    // leniency case — the backup validator (rating_tombstones.json) and
    // the store's own publish shape both require a real number, so the
    // sanitizer must not quietly promote `"1700000000000"` into a
    // deletion the other paths would refuse.
    if (typeof stamp !== 'number' || !Number.isFinite(stamp) || stamp <= 0) continue
    out[key] = clampStamp(normalizeStamp(stamp, 0), Date.now())
  }
  return out
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

    /**
     * variantId → the stamp of the last clear (ADR-0082). Persisted with
     * the map: a clear must survive a reload, or the next snapshot the
     * device publishes could resurrect the record it just deleted.
     * Never pruned — pruning needs to know every peer has adopted, which
     * is unknowable, and the map stays tiny.
     */
    const tombstones = ref<RatingTombstones>({})

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
      // A tombstoned key must not receive a record at or before its clear
      // (deletion wins ties): a device whose clock sits behind the clearing
      // peer's would otherwise write stars that every OTHER device's
      // mergeRemote rejects — the rating would show here and nowhere else.
      // Advance the write one ms past the marker so it is a genuine
      // post-clear opinion everywhere.
      const tomb = tombstones.value[key]
      // The write stamp goes through the SAME future bound as every other
      // timestamp in this store (the stamps.ts funnel — review, ADR-0082):
      // a tombstone sitting AT the skew ceiling would push tomb+1 one ms
      // past now+MAX_FUTURE_SKEW_MS, and peers re-clamping that record
      // DOWN to their ceiling would then compare a different number than
      // we stored — mergeLww and the deletion-wins-ties test would see
      // mismatched stamps across devices, the exact divergence the tomb+1
      // advance exists to prevent.
      //
      // Ceiling collapse: when the tombstone sits exactly at the bound,
      // no strictly-newer stamp exists inside it, so the clamped stamp
      // EQUALS the marker. That is convergent, not divergent: deletion
      // wins ties (ADR-0082), so the fresh opinion loses to the marker on
      // the next inbound reconcile everywhere, instead of surviving with
      // an out-of-bound stamp peers would silently rewrite.
      const stamp = clampStamp(
        Math.max(
          normalizeStamp(updatedAt, Date.now()),
          tomb !== undefined ? tomb + 1 : 0,
        ),
        Date.now(),
      )
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
     * Remove a rating and record WHY (ADR-0082). `setRating(id, 0)` already
     * deletes the local record, but the room transport publishes `ratings`
     * only when non-empty and `mergeLww` never removes keys — a bare
     * delete could never reach peers. The tombstone carries the deletion:
     * it rides every snapshot until every peer has dropped the record.
     * The stamp is clamped through the shared stamps.ts helpers like
     * every timestamp, and the record deletion and tombstone write happen
     * in ONE action so the two can never disagree.
     */
    function clearRating(variantId: number, now: number = Date.now()): void {
      const key = String(variantId)
      // The tombstone must BEAT what it deletes (review, ADR-0082):
      // a record adopted from a peer whose clock ran ahead carries a
      // future-clamped `updatedAt` up to now+MAX_FUTURE_SKEW_MS, and a
      // stamp of bare `now` would sit UNDER it — the peers would keep the
      // record and re-arrival would resurrect it here. Cover the record
      // being deleted AND any existing (possibly newer) marker, then
      // clamp through the shared stamps.ts funnel like every timestamp.
      const record = map.value[key]
      const stamp = clampStamp(
        Math.max(
          normalizeStamp(now, Date.now()),
          record?.updatedAt ?? 0,
          tombstones.value[key] ?? 0,
        ),
        Date.now(),
      )
      if (!(key in map.value)) {
        // Nothing to delete locally, but the tombstone is still written:
        // a peer may still hold the record this device once had, and it
        // must learn the deletion regardless.
        tombstones.value = { ...tombstones.value, [key]: stamp }
        return
      }
      const next = { ...map.value }
      delete next[key]
      map.value = next
      tombstones.value = { ...tombstones.value, [key]: stamp }
    }

    /**
     * Adopt inbound tombstones (room snapshot, backup import — ADR-0082):
     * keep the NEWEST stamp per key, then delete any local record whose
     * `updatedAt <= tombstone` — DELETION WINS TIES, mirroring the
     * "a stale push cannot resurrect" rule (ADR-0031). A record written
     * after the tombstone survives a re-rate and is never touched. The
     * record test uses the RETAINED marker (the max of what we held and
     * what just arrived), never the incoming one: an older echo must not
     * soften a deletion a newer marker already made.
     */
    function mergeTombstones(incoming: unknown): void {
      const clean = sanitizeTombstones(incoming)
      const keys = Object.keys(clean)
      if (keys.length === 0) return
      const nextTombs = { ...tombstones.value }
      for (const key of keys) {
        nextTombs[key] = Math.max(nextTombs[key] ?? 0, clean[key])
      }
      tombstones.value = nextTombs
      let changed = false
      const next: RatingsMap = { ...map.value }
      for (const key of keys) {
        const record = next[key]
        if (record && record.updatedAt <= nextTombs[key]) {
          delete next[key]
          changed = true
        }
      }
      if (changed) map.value = next
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
      // A tombstoned key refuses older-or-equal records outright: a peer
      // that has not adopted the tombstone yet (still publishing its
      // pre-clear snapshot) must not resurrect the record here — this is
      // the receive-side half of "deletion wins ties" (ADR-0082).
      const blocked = Object.entries(clean).filter(
        ([key, record]) => {
          const tomb = tombstones.value[key]
          return tomb !== undefined && record.updatedAt <= tomb
        },
      )
      for (const [key] of blocked) delete clean[key]
      if (Object.keys(clean).length === 0) return
      map.value = mergeLww(map.value, clean)
    }

    return {
      map,
      tombstones,
      ratingFor,
      countFor,
      updatedAtFor,
      setRating,
      clearRating,
      mergeRemote,
      mergeTombstones,
    }
  },
  {
    // A plain record round-trips through JSON untouched — no custom
    // serializer needed (unlike the favourites store's Set).
    persist: { key: 'mealime-planner:v1:ratings', pick: ['map', 'tombstones'] },
  },
)
