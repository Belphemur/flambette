/**
 * Mealime favourites import (ADR-0058): validate-first, atomic — the same
 * discipline as backup import (ADR-0013). A pasted payload is either
 * rejected with a precise error string or fully resolved; nothing is
 * applied until parsing succeeds, and matching never GUESSES.
 *
 * The stable bridge is `recipe_id` (already committed on
 * `variant_meta[].recipe_id`; variant ids are re-issued per API call and
 * are worthless as keys — see the ADR for the measured evidence). The
 * normalized-name fallback exists for id misses; when two catalog
 * variants share a normalized name the row is treated as MISSING rather
 * than matched to one of them.
 */

/** Payload from the bookmarklet: `{source, generatedAt, favourites:[...]}`. */
export interface MealimeFavouriteRow {
  recipe_id?: number
  name?: string
}

export interface MealimePayload {
  source?: string
  generatedAt?: string
  favourites?: MealimeFavouriteRow[]
}

/** One catalog entry the matcher needs. `VariantMeta` satisfies it. */
export interface MealimeImportCatalogEntry {
  id: number
  name: string
  recipe_id: number
}

export type MealimeMatch =
  | { variantId: number; by: 'id' }
  | { variantId: number; by: 'name' }

export interface MealimeMissingRow {
  recipe_id?: number
  name?: string
}

export interface MealimeMatchResult {
  matched: MealimeMatch[]
  missing: MealimeMissingRow[]
  duplicatesDropped: number
}

/** Guards against a runaway paste; a real account is tens of rows. */
const MAX_ROWS = 10_000

/** Lowercase, strip every non-alphanumeric — the tolerance the name
 * fallback matches on (punctuation, casing and whitespace drift). */
export function normalizeMealimeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export type MealimeParseResult =
  | { ok: true; favourites: MealimeFavouriteRow[] }
  | { ok: false; error: string }

/**
 * Validate the pasted text. Accepts the bookmarklet's shape
 * (`{source:'flambette-bookmarklet', favourites:[...]}`) and a
 * defensively-tolerant version of it (a missing `source`, extra fields
 * ignored). A payload that DECLARES a different source is rejected, not
 * reinterpreted.
 */
export function parseMealimePayload(text: string): MealimeParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, error: 'the pasted text is not valid JSON' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'expected a JSON object with a favourites list' }
  }
  const { source, favourites } = parsed as MealimePayload
  if (source !== undefined && source !== 'flambette-bookmarklet') {
    return { ok: false, error: `unknown payload source "${source}"` }
  }
  if (!Array.isArray(favourites)) {
    return { ok: false, error: 'the payload has no favourites list' }
  }
  if (favourites.length > MAX_ROWS) {
    return { ok: false, error: `the payload has too many rows (${favourites.length})` }
  }
  const rows: MealimeFavouriteRow[] = []
  for (const row of favourites) {
    if (typeof row !== 'object' || row === null) continue
    const id = (row as MealimeFavouriteRow).recipe_id
    const name = (row as MealimeFavouriteRow).name
    const clean: MealimeFavouriteRow = {}
    if (typeof id === 'number' && Number.isFinite(id) && id > 0) clean.recipe_id = id
    if (typeof name === 'string' && name.trim() !== '') clean.name = name
    if (clean.recipe_id !== undefined || clean.name !== undefined) rows.push(clean)
  }
  if (rows.length === 0) {
    return { ok: false, error: 'the payload contains no favourites' }
  }
  return { ok: true, favourites: rows }
}

/**
 * Resolve rows against the catalog: `recipe_id` lookup first, then the
 * normalized-name fallback (refused when ambiguous), else MISSING.
 * Duplicate variant ids collapse onto the first occurrence and are
 * counted in `duplicatesDropped`. Pure — applying the matches is the
 * favourites store's job.
 */
export function matchMealimeFavourites(
  rows: MealimeFavouriteRow[],
  catalog: ReadonlyArray<MealimeImportCatalogEntry>,
): MealimeMatchResult {
  const byRecipeId = new Map<number, number>()
  const byName = new Map<string, number | null>()
  for (const entry of catalog) {
    if (Number.isFinite(entry.recipe_id) && !byRecipeId.has(entry.recipe_id)) {
      byRecipeId.set(entry.recipe_id, entry.id)
    }
    const key = normalizeMealimeName(entry.name)
    if (key === '') continue
    // null marks ambiguity: two variants sharing a normalized name can
    // never be matched by name.
    byName.set(key, byName.has(key) ? null : entry.id)
  }

  const matched: MealimeMatch[] = []
  const missing: MealimeMissingRow[] = []
  const seenVariants = new Set<number>()
  let duplicatesDropped = 0

  for (const row of rows) {
    let variantId: number | undefined
    let by: 'id' | 'name' = 'id'
    if (row.recipe_id !== undefined) {
      variantId = byRecipeId.get(row.recipe_id)
    }
    if (variantId === undefined && row.name !== undefined) {
      const hit = byName.get(normalizeMealimeName(row.name))
      if (typeof hit === 'number') {
        variantId = hit
        by = 'name'
      }
    }
    if (variantId === undefined) {
      missing.push({ recipe_id: row.recipe_id, name: row.name })
      continue
    }
    if (seenVariants.has(variantId)) {
      duplicatesDropped++
      continue
    }
    seenVariants.add(variantId)
    matched.push({ variantId, by })
  }
  return { matched, missing, duplicatesDropped }
}
