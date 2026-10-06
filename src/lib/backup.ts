/**
 * Backup / restore of the whole app state as one ZIP file (ADR-0013).
 *
 * Single source of truth: the STORE_SLICES registry below. Export, import
 * AND validation all iterate the same registry — a new persisted store
 * slice MUST register here in the same change (standing rule, AGENTS.md);
 * the e2e registry-coverage case fails any export that skips a slice.
 *
 * Format: a stored (no-compression) ZIP containing meta.json plus one JSON
 * file per registered slice. JSZip was avoided on purpose (new runtime dep
 * for ~120 lines of well-defined byte layout — see src/lib/zip.ts).
 *
 * Import is ATOMIC: every slice file is parsed and validated (plus the
 * meta app-tag/schema check) before the first store is touched; one bad
 * file rejects the whole backup with no partial application.
 */
import type { PlanEntry, CookedEntry } from '../stores/plan'
import type { CustomIngredient } from '../stores/customIngredients'
import { DIET_IDS, type DietId } from './dietFilter'
import { normalizeQuickFilters, type QuickFilters } from './quickFilters'
import { isServings, FALLBACK_SERVINGS, MAX_SERVINGS, MIN_SERVINGS } from './servings'
import { isStepTimer } from './stepTimer'
import { isUnitSystem, UNIT_SYSTEMS } from './units'
import { zipStore, unzipStore, type ZipEntry } from './zip'

/** Backup schema version. Bump + add a migration when the shape evolves. */
export const BACKUP_SCHEMA = 1
const APP_TAG = 'mealime-planner'
const META_FILE = 'meta.json'

/** meta.json inside every backup. */
export interface BackupMeta {
  app: string
  schema: number
  exportedAt: string
}

/** Counts reported after a successful import (toast: "N plans / M items"). */
export interface BackupCounts {
  plans: number
  items: number
  history: number
  ingredients: number
  checks: number
  favourites: number
  ratings: number
}

export interface ApplyResult {
  ok: boolean
  error?: string
  counts?: BackupCounts
}

/* ------------------------------------------------------------------ *
 * STORE_SLICES — the registry (export + import + validation all use it)
 * ------------------------------------------------------------------ */

/** One persisted slice of app state, exposed as one backup file. */
export interface SliceDef<T = unknown> {
  /** File name inside the backup zip (e.g. "plan.json"). */
  file: string
  /** Human label for the import confirm dialog. */
  label: string
  /** Persisted-store keys this slice covers (used by the export-time
   *  registry-coverage assertion below). Slices of the same store share its key. */
  persistKeys: string[]
  /** Current state as a JSON-ready value. */
  read: () => T
  /** Return an error string for malformed data, else null. */
  validate: (value: unknown) => string | null
  /** Replace persisted state via store actions/setters (validation ran first). */
  write: (value: T) => void
}

/** Every registered slice, in the order they are exported/validated/applied. */
export const STORE_SLICES: SliceDef<any>[] = [
  /* Meal plan, custom items, cleared-ingredient snapshots (plan store). */
  {
    file: 'plan.json',
    label: 'meal plan, custom grocery items, cleared ingredients',
    persistKeys: ['mealime-planner:v1:plan'],
    read: () => {
      const plan = usePlanStore()
      return {
        entries: plan.plan.map((e) => ({ variantId: e.variantId, servings: e.servings })),
        customItems: [...plan.customItems],
        clearedIngredients: { ...plan.clearedIngredients },
        // ADR-0034: the plan's identity travels with it, so a restored
        // plan's future cooks group under the plan the rows already name.
        // Omitted entirely for a plan that has no identity yet (an empty
        // plan, or one that has never been minted).
        ...(plan.planId
          ? { planIdentity: { planId: plan.planId, planCreatedAt: plan.planCreatedAt } }
          : {}),
      }
    },
    validate(value) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return 'plan.json must be an object'
      }
      const v = value as Record<string, unknown>
      if (!Array.isArray(v.entries)) return 'plan.json entries must be an array'
      for (const e of v.entries) {
        if (
          typeof e !== 'object' || e === null ||
          typeof (e as PlanEntry).variantId !== 'number' || !Number.isFinite((e as PlanEntry).variantId) ||
          typeof (e as PlanEntry).servings !== 'number' || !Number.isFinite((e as PlanEntry).servings)
        ) {
          return 'plan entries must be {variantId, servings} numbers'
        }
      }
      if (v.customItems !== undefined) {
        if (!Array.isArray(v.customItems) || !(v.customItems as unknown[]).every((i) => typeof i === 'string')) {
          return 'plan.json customItems must be strings'
        }
      }
      if (v.clearedIngredients !== undefined && !isClearedMap(v.clearedIngredients)) {
        return 'plan.json clearedIngredients must map ids to string arrays'
      }
      if (v.planIdentity !== undefined) {
        const id = v.planIdentity as { planId?: unknown; planCreatedAt?: unknown }
        if (
          typeof id !== 'object' || id === null ||
          typeof id.planId !== 'string' || !id.planId ||
          typeof id.planCreatedAt !== 'number' || !Number.isFinite(id.planCreatedAt)
        ) {
          return 'plan.json planIdentity must be {planId: string, planCreatedAt: number}'
        }
      }
      return null
    },
    write(value) {
      const plan = usePlanStore()
      const v = value as {
        entries: PlanEntry[]
        customItems?: string[]
        clearedIngredients?: Record<number, string[]>
        planIdentity?: { planId: string; planCreatedAt: number } | null
      }
      plan.clearPlan()
      plan.clearCustomItems()
      plan.setClearedIngredients({})
      plan.replacePlan(v.entries, v.customItems ?? [])
      if (v.clearedIngredients) plan.setClearedIngredients(v.clearedIngredients)
      // ADR-0034: absent/null clears the identity, which is what a legacy
      // backup means — it predates plan identities.
      plan.setPlanIdentity(v.planIdentity ?? null)
    },
  },
  /* Grocery checkbox map (grocery store). */
  {
    file: 'checked.json',
    label: 'grocery checkbox state',
    persistKeys: ['mealime-planner:v1:checked'],
    read: () => ({ ...useGroceryStore().map }),
    validate(value) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return 'checked.json must be an object'
      }
      for (const [key, val] of Object.entries(value)) {
        if (!key) return 'checked keys must be non-empty strings'
        if (typeof val !== 'boolean') return 'checked values must be booleans'
      }
      return null
    },
    write(value) {
      const grocery = useGroceryStore()
      const map: Record<string, boolean> = {}
      // Keep only true entries, matching the room-sync apply convention.
      for (const [key, val] of Object.entries(value as Record<string, boolean>)) {
        if (val) map[key] = true
      }
      grocery.clearAll()
      grocery.map = map
      // `plan.json` (which carries `customItems`) is applied BEFORE this
      // slice, so the live extras are known here — reconcile against them.
      // An archive can legitimately hold a `custom||<name>` key for an
      // extra it no longer lists (hand-edited, or exported by a build
      // whose extras had already been removed), and the residue makes a
      // re-added extra read as already-done → auto-collapsed away.
      grocery.reconcileExtras(usePlanStore().customItems)
    },
  },
  /* Personal cooked history (plan store, personal slice — always in backups).
   * The per-device `id` (ADR-0032) IS exported: it is the event's identity
   * across the household — other peers hold this same event under its id,
   * so a restored install must keep it or the next merge counts the event
   * twice (restored copy keys by the pair, peers by id). Export and import
   * are id-transparent, so a backup round-trips byte-equal; legacy rows
   * without an id keep the (variantId, cookedAt) pair fallback. */
  {
    file: 'cooked-history.json',
    label: 'cooked-meal history',
    persistKeys: ['mealime-planner:v1:plan'],
    read: () =>
      usePlanStore().cookedHistory.map((h) => ({
        variantId: h.variantId,
        cookedAt: h.cookedAt,
        ...(h.id !== undefined ? { id: h.id } : {}),
        // ADR-0034: plan provenance is exported and imported for the same
        // reason `id` is — it is the event's identity across the household,
        // and a rebuilt row without it would file the cook under "earlier
        // cooks" on the restored device only.
        ...(h.planId !== undefined ? { planId: h.planId } : {}),
        ...(h.planCreatedAt !== undefined ? { planCreatedAt: h.planCreatedAt } : {}),
      })),
    validate(value) {
      if (!Array.isArray(value)) return 'cooked-history.json must be an array'
      for (const r of value) {
        const row = r as CookedEntry
        if (
          typeof r !== 'object' || r === null ||
          typeof row.variantId !== 'number' || !Number.isFinite(row.variantId) ||
          typeof row.cookedAt !== 'number' || !Number.isFinite(row.cookedAt) ||
          (row.id !== undefined && typeof row.id !== 'string') ||
          // ADR-0034: the plan provenance pair is optional, but it is
          // ALL-OR-NOTHING — the check triggers when EITHER field is
          // present, so a row carrying only a planCreatedAt (which would
          // import as a legacy group with a plan date) is refused.
          ((row.planId !== undefined || row.planCreatedAt !== undefined) &&
            (typeof row.planId !== 'string' || !row.planId ||
              typeof row.planCreatedAt !== 'number' || !Number.isFinite(row.planCreatedAt)))
        ) {
          return 'cooked history rows must be {variantId, cookedAt} numbers + optional id string + optional {planId, planCreatedAt} plan provenance'
        }
      }
      return null
    },
    write(value) {
      usePlanStore().replaceCookedHistory(value as CookedEntry[])
    },
  },
  /* Remembered custom-ingredient names (customIngredients store). */
  {
    file: 'custom-ingredients.json',
    label: 'remembered custom ingredient names',
    persistKeys: ['mealime-planner:v1:customIngredients'],
    read: () => useCustomIngredientsStore().list.map((r) => ({ ...r })),
    validate(value) {
      if (!Array.isArray(value)) return 'custom-ingredients.json must be an array'
      for (const r of value) {
        if (
          typeof r !== 'object' || r === null ||
          typeof (r as CustomIngredient).name !== 'string' ||
          typeof (r as CustomIngredient).nameKey !== 'string' || !((r as CustomIngredient).nameKey) ||
          typeof (r as CustomIngredient).category !== 'string'
        ) {
          return 'custom ingredients must be {name, nameKey, category} strings'
        }
      }
      return null
    },
    write(value) {
      useCustomIngredientsStore().replaceAll(value as CustomIngredient[])
    },
  },
  /* Persisted ui prefs (history-sharing opt-OUT + quick filters + household
     room + theme + step timers). ADR-0027 unified the Recipes-tab filters
     into one `quickFilters` object; the legacy `dietFilters` array is still
     EMITTED (mirrored) so a backup restores the diet chips on an install
     that predates the unified model, and still ACCEPTED on import.
     ADR-0032 flipped `shareCookedHistory` to on-by-default: the member is
     the device's opt-OUT choice, and a restore that carries it counts as
     explicit (it also marks the one-time default migration as done, so
     importing an old backup is not re-flipped on the next launch). */
  {
    file: 'settings.json',
    label: 'settings (cooked-history room sharing + quick filters + household room + step timers + theme + default servings + unit system + dietary restrictions)',
    persistKeys: ['mealime-planner:v1:ui'],
    read: () => {
      const ui = useUiStore()
      return {
        shareCookedHistory: ui.shareCookedHistory,
        quickFilters: { ...ui.quickFilters, diets: [...ui.quickFilters.diets] },
        dietFilters: [...ui.quickFilters.diets],
        householdRoom: ui.householdRoom,
        stepTimers: ui.stepTimers,
        theme: readTheme(),
        autoPlanRuleset: ui.autoPlanRuleset,
        autoPlanMode: ui.autoPlanMode,
        autoPlanGeneration: ui.autoPlanGeneration,
        // ADR-0037: the remembered default travels with a backup, so a
        // restored device starts recipes at the household's usual count
        // instead of the authored 6.
        defaultServings: ui.defaultServings,
        // ADR-0047: the device's display unit system travels with a backup
        // like every other ui preference (the registry rule), so a restored
        // device keeps reading recipes in the system it read them in.
        unitSystem: ui.unitSystem,
        // The dietary restrictions travel too (the restriction ADR): the
        // ids are normalized on import by the store's sole writer.
        dietaryRestrictionIds: [...ui.dietaryRestrictionIds],
      }
    },
    validate(value) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return 'settings.json must be an object'
      }
      const v = value as Record<string, unknown>
      if (v.shareCookedHistory !== undefined && typeof v.shareCookedHistory !== 'boolean') {
        return 'settings.json shareCookedHistory must be a boolean'
      }
      if (v.quickFilters !== undefined && !isQuickFilters(v.quickFilters)) {
        return 'settings.json quickFilters must be the unified filter object'
      }
      if (v.dietFilters !== undefined) {
        if (
          !Array.isArray(v.dietFilters) ||
          v.dietFilters.some((d) => typeof d !== 'string' || !DIET_IDS.includes(d as DietId))
        ) {
          return `settings.json dietFilters must be an array of ${DIET_IDS.join('/')}`
        }
      }
      if (v.householdRoom !== undefined && typeof v.householdRoom !== 'string') {
        return 'settings.json householdRoom must be a string'
      }
      if (v.stepTimers !== undefined && !isStepTimersMap(v.stepTimers)) {
        return 'settings.json stepTimers must map variant ids to { timerId: timer }'
      }
      if (v.theme !== undefined) {
        if (typeof v.theme !== 'object' || v.theme === null || Array.isArray(v.theme)) {
          return 'settings.json theme must be an object'
        }
        const t = (v.theme as { theme?: unknown }).theme
        if (t !== undefined && t !== '' && t !== 'dark' && t !== 'light') {
          return 'settings.json theme.theme must be "dark", "light" or ""'
        }
      }
      if (
        v.autoPlanRuleset !== undefined &&
        !(AUTO_PLAN_RULESETS as readonly string[]).includes(v.autoPlanRuleset as string)
      ) {
        return `settings.json autoPlanRuleset must be one of ${AUTO_PLAN_RULESETS.join('/')}`
      }
      if (
        v.autoPlanMode !== undefined &&
        v.autoPlanMode !== 'add' &&
        v.autoPlanMode !== 'replace'
      ) {
        return 'settings.json autoPlanMode must be "add" or "replace"'
      }
      if (
        v.autoPlanGeneration !== undefined &&
        (typeof v.autoPlanGeneration !== 'number' ||
          !Number.isFinite(v.autoPlanGeneration) ||
          v.autoPlanGeneration < 0 ||
          !Number.isInteger(v.autoPlanGeneration) ||
          // Cap at MAX_SAFE_INTEGER: anything bigger (Number.MAX_VALUE is
          // a valid "integer") would overflow to Infinity on the next
          // increment and break `generation % k` in the planner (qodo
          // round 1, thread 3).
          v.autoPlanGeneration > Number.MAX_SAFE_INTEGER)
      ) {
        return 'settings.json autoPlanGeneration must be a non-negative integer'
      }
      // Optional: a backup predating ADR-0037 has no key, which is a
      // valid "don't touch". A key that IS present must be a real count —
      // import is validation-first, so a malformed one rejects the whole
      // archive rather than being silently repaired.
      if (v.defaultServings !== undefined && !isServings(v.defaultServings)) {
        return `settings.json defaultServings must be an integer between ${MIN_SERVINGS} and ${MAX_SERVINGS}`
      }
      // ADR-0047: absent is a valid "don't touch" (a pre-ADR-0047 backup);
      // present must be one of the two systems, because import is
      // validation-first and a malformed value would disable the display
      // transform on every surface.
      if (v.unitSystem !== undefined && !isUnitSystem(v.unitSystem)) {
        return `settings.json unitSystem must be one of ${UNIT_SYSTEMS.join('/')}`
      }
      // The restriction ADR: absent is a valid "don't touch" (a pre-
      // restriction backup); present must be an array of integer ids —
      // import is validation-first, and unknown ids are DROPPED at write
      // time by the store's sole writer rather than failing the archive.
      if (
        v.dietaryRestrictionIds !== undefined &&
        (!Array.isArray(v.dietaryRestrictionIds) ||
          v.dietaryRestrictionIds.some((x) => typeof x !== 'number' || !Number.isInteger(x)))
      ) {
        return 'settings.json dietaryRestrictionIds must be an array of integer restriction ids'
      }
      return null
    },
    write(value) {
      const v = value as {
        shareCookedHistory?: boolean
        quickFilters?: unknown
        dietFilters?: DietId[]
        householdRoom?: string
        stepTimers?: unknown
        theme?: { theme?: string }
        autoPlanRuleset?: unknown
        autoPlanMode?: unknown
        autoPlanGeneration?: unknown
        defaultServings?: unknown
        unitSystem?: unknown
        dietaryRestrictionIds?: unknown
      }
      useUiStore().applySettings({
        shareCookedHistory: v.shareCookedHistory,
        // Explicit defaults for fields absent from OLDER backups (qodo
        // 4128519628): applySettings otherwise leaves the device's current
        // values in place even though the restore claims settings are
        // overwritten. {} / '' / [] are valid values for applySettings.
        quickFilters:
          v.quickFilters ?? (Array.isArray(v.dietFilters) ? { diets: v.dietFilters } : {}),
        householdRoom: v.householdRoom ?? '',
        stepTimers: v.stepTimers ?? {},
        autoPlanRuleset: v.autoPlanRuleset ?? 'dinner',
        autoPlanMode: v.autoPlanMode ?? 'add',
        autoPlanGeneration: v.autoPlanGeneration ?? 0,
        // Same rule: a pre-ADR-0037 backup restores the authored 6 rather
        // than leaving the device's own default in place.
        defaultServings: v.defaultServings ?? FALLBACK_SERVINGS,
        // ADR-0047: deliberately NOT defaulted. The system is a reading
        // preference, and a backup that predates it says nothing about the
        // device's — "absent = don't touch" keeps a restore from silently
        // flipping a metric device to imperial (or the reverse).
        unitSystem: v.unitSystem,
        // Deliberately NOT defaulted (the ADR-0047 rule): a backup that
        // predates restrictions says nothing about the device's — absent
        // means "don't touch", never a wipe.
        dietaryRestrictionIds: v.dietaryRestrictionIds,
      })
      if (v.theme) writeTheme(v.theme.theme ?? '')
    },
  },
  /* Favourite variant ids (favourites store). */
  {
    file: 'favourites.json',
    label: 'favourite recipes',
    persistKeys: ['mealime-planner:v1:favourites'],
    read: () => [...useFavouritesStore().ids],
    validate(value) {
      if (!Array.isArray(value)) return 'favourites.json must be an array'
      return value.every((id) => typeof id === 'number' && Number.isFinite(id))
        ? null
        : 'favourites.json must be an array of numbers'
    },
    write(value) {
      useFavouritesStore().replaceAll(value as number[])
    },
  },
  /* Household per-recipe stars (ratings store, ADR-0031). Ratings are
     opinion, so this file is the ONLY carrier — the catalog rating stays
     read-only in builder_data and is never written here. Rows carry the
     id and the `updatedAt` merge key, and import RECONCILES per record
     (newer wins) so restoring an older backup cannot clobber household
     ratings written since. */
  {
    file: 'ratings.json',
    label: 'your recipe ratings',
    persistKeys: ['mealime-planner:v1:ratings'],
    read: () => ratingsToRows(useRatingStore().map),
    validate(value) {
      if (!Array.isArray(value)) return 'ratings.json must be an array of rating records'
      for (const row of value) {
        if (typeof row !== 'object' || row === null || Array.isArray(row)) {
          return 'ratings.json rows must be objects'
        }
        const { id, rating, count, updatedAt } = row as Record<string, unknown>
        if (typeof id !== 'number' || !Number.isFinite(id)) {
          return 'ratings.json rows need a numeric id'
        }
        if (typeof rating !== 'number' || !Number.isFinite(rating) || rating <= 0 || rating > 5) {
          return 'ratings.json ratings must be numbers in (0, 5]'
        }
        if (typeof count !== 'number' || !Number.isFinite(count) || count < 1) {
          return 'ratings.json counts must be numbers >= 1'
        }
        if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) || updatedAt < 0) {
          return 'ratings.json updatedAt must be a finite, non-negative timestamp'
        }
      }
      return null
    },
    write(value) {
      // Merge, never replace: an older backup must not erase a rating
      // this device took after the backup was written (ADR-0031). The
      // per-record merge adopts each row verbatim — including its count —
      // so importing never inflates the smoothing weight.
      useRatingStore().mergeRemote(
        Object.fromEntries(
          (value as RatingFileRow[]).map((row) => [String(row.id), row]),
        ),
      )
    },
  },
]

function isStepTimersMap(value: unknown): boolean {  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.entries(value as Record<string, unknown>).every(([variant, views]) => {
    if (!/^\d+$/.test(variant)) return false
    if (typeof views !== 'object' || views === null || Array.isArray(views)) return false
    return Object.entries(views as Record<string, unknown>).every(
      ([view, timer]) => /^\d+$/.test(view) && isStepTimer(timer),
    )
  })
}

/**
 * A settings.json `quickFilters` member is accepted when it normalizes to a
 * COMPLETE filter set (ADR-0027). `null` only for shapes that cannot be a
 * filter object at all — the normalizer itself repairs partial/unknown
 * members, which is what keeps older peers and hand-edited files usable.
 */
function isQuickFilters(value: unknown): value is QuickFilters {
  return normalizeQuickFilters(value) !== null
}

function isClearedMap(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.entries(value).every(
    ([k, v]) => /^\d+$/.test(k) && Array.isArray(v) && v.every((s) => typeof s === 'string'),
  )
}

/* ------------------------------------------------------------------ *
 * Theme bridge (useDark persists under its own localStorage key, which
 * is not a Pinia slice — bridged here so backups carry the override).
 * ------------------------------------------------------------------ */

const THEME_KEY = 'vueuse-color-scheme'

function readTheme(): { theme: string } {
  const raw = localStorage.getItem(THEME_KEY) ?? ''
  return { theme: raw === 'dark' || raw === 'light' ? raw : '' }
}

function writeTheme(theme: string): void {
  if (theme === 'dark' || theme === 'light') {
    localStorage.setItem(THEME_KEY, theme)
  } else {
    localStorage.removeItem(THEME_KEY)
  }
  // useDark follows storage changes (vueuse useStorage listens natively);
  // covering the plain-setItem case for same-tab reactivity too.
  window.dispatchEvent(
    new StorageEvent('storage', { key: THEME_KEY, newValue: theme || null, storageArea: localStorage }),
  )
}

/* ------------------------------------------------------------------ *
 * Export
 * ------------------------------------------------------------------ */

/** Build the backup zip bytes (stored entries) from the registry. */
/**
 * Registry-coverage assertion: EVERY persisted `mealime-planner:v1:*`
 * localStorage key must be covered by a registered slice. A new store
 * that skips registration fails every export here (standing AGENTS.md
 * rule; asserted by the e2e registry-coverage case).
 */
function assertRegistryCoverage(): void {
  const covered = new Set(STORE_SLICES.flatMap((s) => s.persistKeys))
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key?.startsWith('mealime-planner:v1:') && !covered.has(key)) {
      throw new Error(
        `Persisted slice "${key}" is not registered in STORE_SLICES — it would disappear from backups (see AGENTS.md)`,
      )
    }
  }
}

export function buildBackupZip(): Uint8Array {
  assertRegistryCoverage()
  const files: ZipEntry[] = [
    {
      name: META_FILE,
      data: new TextEncoder().encode(
        JSON.stringify({ app: APP_TAG, schema: BACKUP_SCHEMA, exportedAt: new Date().toISOString() }),
      ),
    },
  ]
  for (const slice of STORE_SLICES) {
    files.push({ name: slice.file, data: new TextEncoder().encode(JSON.stringify(slice.read())) })
  }
  return zipStore(files)
}

/** `mealime-planner-backup-YYYYMMDD.zip` for the given date (default now). */
export function backupFileName(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `mealime-planner-backup-${y}${m}${d}.zip`
}

/* ------------------------------------------------------------------ *
 * Import (validation-first, atomic)
 * ------------------------------------------------------------------ */

/** Registry slice filenames, for tests and tooling. */
export const BACKUP_FILES = [META_FILE, ...STORE_SLICES.map((s) => s.file)]

/**
 * Import a backup zip: validate EVERYTHING (meta + every registered slice
 * present in the archive), then apply. Missing slice files are tolerated
 * (applied as their empty shape) so partial zips stay restorable; any
 * malformed slice or a bad meta rejects the whole import untouched.
 * Returns { ok, counts } or { ok: false, error }.
 */
export function applyBackup(zipBytes: Uint8Array): ApplyResult {
  const entries = unzipStore(zipBytes)
  if (typeof entries === 'string') return { ok: false, error: entries + ' — file damaged or not a backup' }

  /* ---- meta.json ---- */
  const metaRaw = entries.get(META_FILE)
  if (!metaRaw) {
    return { ok: false, error: `Missing ${META_FILE} — file damaged or not a backup` }
  }
  let meta: unknown
  try {
    meta = JSON.parse(new TextDecoder().decode(metaRaw))
  } catch {
    return { ok: false, error: 'meta.json is not valid JSON' }
  }
  if (typeof meta !== 'object' || meta === null) return { ok: false, error: 'meta.json must be an object' }
  const m = meta as Record<string, unknown>
  if (m.app !== APP_TAG) {
    return { ok: false, error: 'Not a mealime-planner backup (wrong app tag)' }
  }
  if (m.schema !== BACKUP_SCHEMA) {
    return { ok: false, error: `Unsupported backup schema (${String(m.schema)}) — expected ${BACKUP_SCHEMA}` }
  }
  if (typeof m.exportedAt !== 'string' || !m.exportedAt) {
    return { ok: false, error: 'meta.json exportedAt must be a timestamp string' }
  }

  /* ---- slices: parse + validate all BEFORE any store mutation ---- */
  type Validated = { slice: SliceDef<any>; value: unknown; present: boolean }
  const validated: Validated[] = []
  for (const slice of STORE_SLICES) {
    const raw = entries.get(slice.file)
    let value: unknown
    let present = false
    if (raw === undefined) {
      // Missing slice file: keep current state (no-op apply).
      value = slice.read()
    } else {
      let parsed: unknown
      try {
        parsed = JSON.parse(new TextDecoder().decode(raw))
      } catch {
        return { ok: false, error: `${slice.file} is not valid JSON` }
      }
      const error = slice.validate(parsed)
      if (error) return { ok: false, error: `${slice.file}: ${error}` }
      value = parsed
      present = true
    }
    validated.push({ slice, value, present })
  }

  /* ---- apply ---- */
  for (const { slice, value } of validated) {
    slice.write(value)
  }

  const byFile = new Map(validated.filter((v) => v.present).map((v) => [v.slice.file, v.value]))
  const counts: BackupCounts = {
    plans: (byFile.get('plan.json') as { entries: PlanEntry[] } | undefined)?.entries.length ?? 0,
    items: (byFile.get('plan.json') as { customItems?: string[] } | undefined)?.customItems?.length ?? 0,
    history: (byFile.get('cooked-history.json') as CookedEntry[] | undefined)?.length ?? 0,
    ingredients: (byFile.get('custom-ingredients.json') as CustomIngredient[] | undefined)?.length ?? 0,
    checks: Object.keys((byFile.get('checked.json') as Record<string, boolean> | undefined) ?? {}).length,
    favourites: (byFile.get('favourites.json') as number[] | undefined)?.length ?? 0,
    ratings: ((byFile.get('ratings.json') as unknown[]) ?? []).length,
  }
  return { ok: true, counts }
}

/* Store imports are kept at the bottom so the registry above reads without
 * a wall of imports; imports are hoisted by ES modules so this is safe. */
import { usePlanStore } from '../stores/plan'
import { useGroceryStore } from '../stores/grocery'
import { AUTO_PLAN_RULESETS, useUiStore } from '../stores/ui'
import { useCustomIngredientsStore } from '../stores/customIngredients'
import { useFavouritesStore } from '../stores/favourites'
import { ratingsToRows, useRatingStore, type RatingFileRow } from '../stores/rating'
