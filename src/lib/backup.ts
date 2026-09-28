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
      return null
    },
    write(value) {
      const plan = usePlanStore()
      const v = value as {
        entries: PlanEntry[]
        customItems?: string[]
        clearedIngredients?: Record<number, string[]>
      }
      plan.clearPlan()
      plan.clearCustomItems()
      plan.setClearedIngredients({})
      plan.replacePlan(v.entries, v.customItems ?? [])
      if (v.clearedIngredients) plan.setClearedIngredients(v.clearedIngredients)
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
    },
  },
  /* Personal cooked history (plan store, personal slice — always in backups). */
  {
    file: 'cooked-history.json',
    label: 'cooked-meal history',
    persistKeys: ['mealime-planner:v1:plan'],
    read: () => usePlanStore().cookedHistory.map((h) => ({ ...h })),
    validate(value) {
      if (!Array.isArray(value)) return 'cooked-history.json must be an array'
      for (const r of value) {
        if (
          typeof r !== 'object' || r === null ||
          typeof (r as CookedEntry).variantId !== 'number' || !Number.isFinite((r as CookedEntry).variantId) ||
          typeof (r as CookedEntry).cookedAt !== 'number' || !Number.isFinite((r as CookedEntry).cookedAt)
        ) {
          return 'cooked history rows must be {variantId, cookedAt} numbers'
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
  /* Persisted ui prefs (share setting + diet filters + household room + theme). */
  {
    file: 'settings.json',
    label: 'settings (cooked-history room sharing + diet filters + household room + theme)',
    persistKeys: ['mealime-planner:v1:ui'],
    read: () => ({
      shareCookedHistory: useUiStore().shareCookedHistory,
      dietFilters: [...useUiStore().dietFilters],
      householdRoom: useUiStore().householdRoom,
      theme: readTheme(),
    }),
    validate(value) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return 'settings.json must be an object'
      }
      const v = value as Record<string, unknown>
      if (v.shareCookedHistory !== undefined && typeof v.shareCookedHistory !== 'boolean') {
        return 'settings.json shareCookedHistory must be a boolean'
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
      if (v.theme !== undefined) {
        if (typeof v.theme !== 'object' || v.theme === null || Array.isArray(v.theme)) {
          return 'settings.json theme must be an object'
        }
        const t = (v.theme as { theme?: unknown }).theme
        if (t !== undefined && t !== '' && t !== 'dark' && t !== 'light') {
          return 'settings.json theme.theme must be "dark", "light" or ""'
        }
      }
      return null
    },
    write(value) {
      const v = value as {
        shareCookedHistory?: boolean
        dietFilters?: DietId[]
        householdRoom?: string
        theme?: { theme?: string }
      }
      useUiStore().applySettings({
        shareCookedHistory: v.shareCookedHistory,
        dietFilters: v.dietFilters,
        householdRoom: v.householdRoom,
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
]

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
  }
  return { ok: true, counts }
}

/* Store imports are kept at the bottom so the registry above reads without
 * a wall of imports; imports are hoisted by ES modules so this is safe. */
import { usePlanStore } from '../stores/plan'
import { useGroceryStore } from '../stores/grocery'
import { useUiStore } from '../stores/ui'
import { useCustomIngredientsStore } from '../stores/customIngredients'
import { useFavouritesStore } from '../stores/favourites'
