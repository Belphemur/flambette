/**
 * The unified quick-filter model (ADR-0027).
 *
 * Before this module the Recipes tab had TWO surfaces for one concept: a
 * "All diets" category dropdown (variant_data.category_name: fish / meat /
 * vegetarian) AND a diet-chip row (ADR-0018 keyword rules). Every filter
 * lived in a different local `ref` except the diet chips, so nothing
 * persisted except the chips and nothing synced (ADR-0027).
 *
 * One plain object is the single source of truth for ALL of it:
 *   - persisted locally (ui store, under the existing `mealime-planner:v1:ui`
 *     key — no new store, no new STORE_SLICES entry needed),
 *   - carried in the room payload as an OPTIONAL `filters` key (WS3/WS4),
 *   - sanitized on every inbound path (backup import, remote snapshot).
 *
 * Pure + no Vue/Pinia: the same helpers run in the store, in a view and in
 * bun-test, so a bad payload can never leak a raw value into the UI.
 */
import { DIET_IDS, type DietId } from './dietFilter'

/** Sort modes offered by the Recipes tab (ADR-0027). */
export type SortBy = 'rating' | 'latest' | 'popularity' | 'time' | 'calories'

/**
 * Protein slice, i.e. the former "All diets" category dropdown. The catalog
 * has exactly three category names (`fish`, `meat`, `vegetarian`); `''`
 * means "any". A single value, not a set: a recipe has one category.
 */
export type ProteinFilter = '' | 'fish' | 'meat' | 'vegetarian'

export const SORT_OPTIONS: readonly { value: SortBy; label: string }[] = [
  { value: 'rating', label: 'Top rated' },
  { value: 'latest', label: 'Latest' },
  { value: 'popularity', label: 'Most popular' },
  { value: 'time', label: 'Quickest' },
  { value: 'calories', label: 'Fewest calories' },
]

export const SORT_VALUES: readonly SortBy[] = SORT_OPTIONS.map((o) => o.value)

/** Protein chips, in display order. `''` ("Any") is the default state. */
export const PROTEIN_OPTIONS: readonly { value: ProteinFilter; label: string }[] = [
  { value: '', label: 'Any protein' },
  { value: 'fish', label: 'Fish' },
  { value: 'meat', label: 'Meat' },
  { value: 'vegetarian', label: 'Vegetarian' },
]

export const PROTEIN_VALUES: readonly ProteinFilter[] = PROTEIN_OPTIONS.map((o) => o.value)

/** Cook-time buckets offered by the filter bar (minutes; null = any). */
export const TIME_OPTIONS: readonly (number | null)[] = [null, 20, 30, 45]

/**
 * The HALF of the quick filters that is household state (ADR-0028).
 *
 * `favOnly` is deliberately absent. As of ADR-0031 the favourites SET
 * itself IS shared, but the SWITCH is still personal: sharing it would
 * impose one device's "show only favourites" on a device that has
 * starred nothing yet and render its Recipes tab blank. The switch
 * persists locally; it does not travel.
 */
export type SharedQuickFilters = Omit<QuickFilters, 'favOnly'>

/** Strip the personal half for the room payload. */
export function toSharedFilters(f: QuickFilters): SharedQuickFilters {
  const { favOnly: _personal, ...shared } = f
  return shared
}

/**
 * Fold an inbound household selection onto the local one, keeping the
 * personal members (`favOnly`) untouched.
 */
export function mergeSharedFilters(
  incoming: QuickFilters,
  local: QuickFilters,
): QuickFilters {
  return { ...incoming, favOnly: local.favOnly }
}

export interface QuickFilters {
  /** ANDed diet keyword rules (ADR-0018). */
  diets: DietId[]
  /** Single protein category, or '' for any. */
  protein: ProteinFilter
  /** Max cooking minutes, or null for any. */
  maxTime: number | null
  sortBy: SortBy
  favOnly: boolean
  proOnly: boolean
}

export function defaultQuickFilters(): QuickFilters {
  return { diets: [], protein: '', maxTime: null, sortBy: 'rating', favOnly: false, proOnly: false }
}

/** Human label of a sort mode (falls back to the first option). */
export function sortLabel(sortBy: SortBy): string {
  return SORT_OPTIONS.find((o) => o.value === sortBy)?.label ?? SORT_OPTIONS[0].label
}

/** Human label of a protein chip. */
export function proteinLabel(protein: ProteinFilter): string {
  return PROTEIN_OPTIONS.find((o) => o.value === protein)?.label ?? PROTEIN_OPTIONS[0].label
}

function asDietId(value: unknown): DietId | null {
  return typeof value === 'string' && DIET_IDS.includes(value as DietId) ? (value as DietId) : null
}

/**
 * Coerce an UNTRUSTED object (backup import, remote room snapshot) into a
 * complete QuickFilters. Unknown / malformed members fall back to the
 * default, and unknown diet ids are DROPPED rather than trusted (the rule
 * set is frozen). Returns null only when `value` is not an object at all —
 * the caller then treats the payload as "no filters present" and leaves
 * the local selection untouched (backward compatibility with older peers,
 * WS3).
 */
export function normalizeQuickFilters(value: unknown): QuickFilters | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  const base = defaultQuickFilters()
  const diets = Array.isArray(v.diets)
    ? [...new Set(v.diets.map(asDietId).filter((d): d is DietId => d !== null))]
    : []
  return {
    diets,
    protein: PROTEIN_VALUES.includes(v.protein as ProteinFilter)
      ? (v.protein as ProteinFilter)
      : base.protein,
    // Only the VALUES the control actually offers. A payload carrying
    // `maxTime: -1` would otherwise pass normalization and make the
    // facet reject every recipe, with no select option to reset it.
    maxTime: TIME_OPTIONS.includes(v.maxTime as number | null) ? (v.maxTime as number | null) : null,
    sortBy: SORT_VALUES.includes(v.sortBy as SortBy) ? (v.sortBy as SortBy) : base.sortBy,
    favOnly: typeof v.favOnly === 'boolean' ? v.favOnly : base.favOnly,
    proOnly: typeof v.proOnly === 'boolean' ? v.proOnly : base.proOnly,
  }
}

/** Structural equality, for no-op suppression in the room push watcher. */
export function sameQuickFilters(a: QuickFilters, b: QuickFilters): boolean {
  return (
    a.sortBy === b.sortBy &&
    a.protein === b.protein &&
    a.maxTime === b.maxTime &&
    a.favOnly === b.favOnly &&
    a.proOnly === b.proOnly &&
    a.diets.length === b.diets.length &&
    a.diets.every((d, i) => d === b.diets[i])
  )
}

/**
 * One-shot migration for state persisted BEFORE the unified model (v0.12
 * and older): the ui blob has a `dietFilters` array and no `quickFilters`.
 * Returns the filters to seed, or null when there is nothing to migrate
 * (no blob, already migrated, or the stored diets are not an array).
 *
 * Kept as a pure string-in/object-out function so the ui store only has to
 * do the localStorage read, and so bun-test can pin the migration.
 */
export function migrateLegacyUiFilters(raw: string | null): QuickFilters | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const v = parsed as Record<string, unknown>
  if (v.quickFilters !== undefined) return null // already migrated
  if (!Array.isArray(v.dietFilters)) return null
  return normalizeQuickFilters({ diets: v.dietFilters })
}

/** True when anything narrows the result set (the search box is separate). */
export function hasActiveFilters(f: QuickFilters): boolean {
  return (
    f.diets.length > 0 ||
    f.protein !== '' ||
    f.maxTime !== null ||
    f.favOnly ||
    f.proOnly
  )
}
