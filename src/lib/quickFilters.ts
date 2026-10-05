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
import { normalizeMealType, type MealTypeId } from './mealTypeFilter'
import { isUserRecipeId } from './userRecipes'

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
 * Where a recipe came from (ADR-0054 §3) — the replacement for the
 * retired `proOnly` boolean.
 *
 *   - `all`: the whole catalog, Mealime's and the household's own.
 *   - `pro`: `meta.is_pro`, the Mealime subscription recipes. This is
 *     what `proOnly: true` meant, and it keeps that meaning EXACTLY, so
 *     the migration below is a rename and not a reinterpretation.
 *   - `new`: the household's own recipes, and it is PERMANENT — every
 *     non-Mealime recipe, forever (locked decision L1). What expires
 *     after `NEW_BADGE_DAYS` is the NEW badge on the card, not
 *     membership of this bucket, so there is deliberately no fourth
 *     "recently added" option that could quietly empty itself.
 *
 * `pro` and `new` are NOT complements: a PRO recipe is a Mealime
 * recipe, so `pro` never overlaps `new`. That is why this replaced the
 * boolean rather than becoming a second one beside it.
 */
export type SourceFilter = 'all' | 'pro' | 'new'

/** Source options, in display order. `all` is the default state. */
export const SOURCE_OPTIONS: readonly { value: SourceFilter; label: string }[] = [
  { value: 'all', label: 'All sources' },
  { value: 'pro', label: 'PRO' },
  { value: 'new', label: 'New' },
]

export const SOURCE_VALUES: readonly SourceFilter[] = SOURCE_OPTIONS.map((o) => o.value)

/** The facet itself: one meta + the loaded id set in, one boolean out. */
export function matchesSource(
  source: SourceFilter,
  meta: { id: number; is_pro?: boolean },
  userRecipeIds: ReadonlySet<number>,
): boolean {
  if (source === 'all') return true
  if (source === 'pro') return meta.is_pro === true
  // The artifact's id set is the ONLY truth for "the household wrote
  // this" — `VariantMeta` is frozen and gains no flag (ADR-0054 §1).
  return isUserRecipeId(meta.id, userRecipeIds)
}

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
  /**
   * Meal occasion (ADR-0043), or null for Any. The buckets are the
   * CATALOG's own `ruleset` values, so this is an exact facet, not a
   * heuristic lens like the diets above.
   */
  mealType: MealTypeId | null
  /** Max cooking minutes, or null for any. */
  maxTime: number | null
  sortBy: SortBy
  favOnly: boolean
  /**
   * Which catalog the recipe came from (ADR-0054 §3). Part of the SHARED
   * (household) half, like every member but `favOnly`: a household
   * browsing "New" is browsing together.
   */
  source: SourceFilter
}

export function defaultQuickFilters(): QuickFilters {
  return {
    diets: [],
    protein: '',
    mealType: null,
    maxTime: null,
    sortBy: 'rating',
    favOnly: false,
    source: 'all',
  }
}

/** Human label of a sort mode (falls back to the first option). */
export function sortLabel(sortBy: SortBy): string {
  return SORT_OPTIONS.find((o) => o.value === sortBy)?.label ?? SORT_OPTIONS[0].label
}

/** Human label of a protein chip. */
export function proteinLabel(protein: ProteinFilter): string {
  return PROTEIN_OPTIONS.find((o) => o.value === protein)?.label ?? PROTEIN_OPTIONS[0].label
}

/** Human label of a source option (falls back to the first option). */
export function sourceLabel(source: SourceFilter): string {
  return SOURCE_OPTIONS.find((o) => o.value === source)?.label ?? SOURCE_OPTIONS[0].label
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
    // Same drop-unknown rule as the diet ids: an id the dropdown does not
    // offer (or a `cpg` bucket that is counted but never offered) is
    // refused, so a stale peer can never park the tab on an empty grid.
    mealType: normalizeMealType(v.mealType),
    // Only the VALUES the control actually offers. A payload carrying
    // `maxTime: -1` would otherwise pass normalization and make the
    // facet reject every recipe, with no select option to reset it.
    maxTime: TIME_OPTIONS.includes(v.maxTime as number | null) ? (v.maxTime as number | null) : null,
    sortBy: SORT_VALUES.includes(v.sortBy as SortBy) ? (v.sortBy as SortBy) : base.sortBy,
    favOnly: typeof v.favOnly === 'boolean' ? v.favOnly : base.favOnly,
    source: normalizeSource(v.source, v.proOnly),
  }
}

/**
 * The ONE coercion point for the source facet, and the whole of ADR-0054
 * §3's migration.
 *
 * An explicit `source` always wins. A payload carrying only the retired
 * `proOnly` boolean maps `true -> 'pro'` and `false`/absent to `'all'`.
 * That is a RENAME, not a reinterpretation: the old chip said "PRO
 * recipes only" and the `pro` bucket says the same thing, so a household
 * that had pinned it keeps exactly the grid they had.
 *
 * Doing it HERE rather than in a separate migration function is what
 * keeps a single spelling in the persisted type while still covering
 * every inbound path at once: the persisted ui blob, a backup JSON, and
 * an older peer's room snapshot all arrive through this function. A
 * second spelling in the interface would be the drift this repo's
 * conventions forbid — and it is a real trap here, because the legacy
 * `dietFilters` blob path (`migrateLegacyUiFilters`) forwards only the
 * members it knows, so a `proOnly` in an OLD blob would be dropped
 * without this branch.
 */
function normalizeSource(value: unknown, legacyProOnly: unknown): SourceFilter {
  if (typeof value === 'string' && (SOURCE_VALUES as readonly string[]).includes(value)) {
    return value as SourceFilter
  }
  if (legacyProOnly === true) return 'pro'
  return 'all'
}

/** Structural equality, for no-op suppression in the room push watcher. */
export function sameQuickFilters(a: QuickFilters, b: QuickFilters): boolean {
  return (
    a.sortBy === b.sortBy &&
    a.protein === b.protein &&
    a.mealType === b.mealType &&
    a.maxTime === b.maxTime &&
    a.favOnly === b.favOnly &&
    a.source === b.source &&
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
 * The legacy blob is forwarded WHOLE, not as `{ diets }` alone, so the
 * `proOnly` boolean a v0.12-era blob may also carry still reaches
 * `normalizeQuickFilters` and becomes `source: 'pro'` (ADR-0054 §3). A
 * blob that predates the unified model predates `proOnly` too, so this is
 * belt-and-braces — but the branch that would drop it is exactly the
 * kind of silent data loss this repo's conventions forbid.
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
  return normalizeQuickFilters({ ...v, diets: v.dietFilters })
}

/**
 * The RAW-blob half of the `proOnly` migration (ADR-0054 §3).
 *
 * The ui store hydrates by $patch deep-merging the persisted blob into the
 * DEFAULT filters, so the hydrated `quickFilters` ALWAYS carries
 * `source: 'all'` — a migration reading hydrated state would let that default
 * win over the legacy member and silently downgrade a pinned PRO filter.
 * This helper reads the RAW blob instead and answers the only question that
 * matters: does the blob carry a retired `proOnly` with NO explicit `source`
 * beside it (i.e. a genuinely pre-ADR-0054 blob, never a fresh install — a
 * fresh install's blob has neither member)?
 *
 * Returns `{ source }` to spread OVER the hydrated filters, or null when the
 * blob says nothing about source.
 */
export function legacyProOnlySource(raw: string | null): { source: SourceFilter } | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const blob = parsed as Record<string, unknown>
  const blobProOnly = (blob.proOnly ?? (typeof blob.quickFilters === 'object' && blob.quickFilters !== null
    ? (blob.quickFilters as Record<string, unknown>).proOnly
    : undefined))
  if (blobProOnly === undefined) return null
  const blobSource =
    typeof blob.quickFilters === 'object' && blob.quickFilters !== null
      ? (blob.quickFilters as Record<string, unknown>).source
      : undefined
  if (blobSource !== undefined) return null // current spelling present: not a legacy blob
  return { source: blobProOnly === true ? 'pro' : 'all' }
}

/** True when anything narrows the result set (the search box is separate). */
export function hasActiveFilters(f: QuickFilters): boolean {
  return (
    f.diets.length > 0 ||
    f.protein !== '' ||
    f.mealType !== null ||
    f.maxTime !== null ||
    f.favOnly ||
    f.source !== 'all'
  )
}
