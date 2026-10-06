/**
 * Changelog runtime module (ADR-0060 §4).
 *
 * The artifact `public/data/changelog.json` is untrusted input (it's a
 * committed build derivation, not a runtime contract). `src/lib/changelog.ts`
 * validates and normalizes it with the same defensive stance as the backup
 * import: unknown/missing fields tolerated, wrong types dropped or defaulted,
 * newest-first enforced.
 *
 * Pure — no Vue/Pinia/fetch — so the same helpers run in the store, in a view
 * and in bun-test.
 */
/** The committed artifact shape: a list of versions newest-first. */
export interface ChangelogDoc {
  generatedAt: string
  versions: NormalizedVersion[]
}

/** A single entry as it should reach the UI after normalization. */
export interface ChangelogEntry {
  text: string
  scope: string | null
  pr: number | null
  adr: string | null
}

/** A version row, normalized. `date`/`title` always present; features/fixes
 *  optional but typed if present. */
export interface NormalizedVersion {
  version: string
  date: string
  title: string
  features: ChangelogEntry[]
  fixes: ChangelogEntry[]
}

const VALID_VERSION_RE = /^v\d+\.\d+\.\d+$/

function normalizeEntry(raw: unknown): ChangelogEntry | null {
  if (raw === null || typeof raw !== 'object') return null
  const e = raw as Record<string, unknown>
  const text = typeof e.text === 'string' ? e.text : ''
  if (!text) return null
  return {
    text,
    scope: typeof e.scope === 'string' && e.scope.length > 0 ? e.scope : null,
    pr: typeof e.pr === 'number' && Number.isInteger(e.pr) && e.pr > 0 ? e.pr : null,
    adr: typeof e.adr === 'string' && /^ADR-\d+$/.test(e.adr) ? e.adr : null,
  }
}

function normalizeVersion(raw: unknown): NormalizedVersion | null {
  if (raw === null || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  const version = typeof v.version === 'string' ? v.version : ''
  if (!version || !VALID_VERSION_RE.test(version)) return null
  const title = typeof v.title === 'string' && v.title.length > 0 ? v.title : version
  const date = typeof v.date === 'string' && v.date.length > 0 ? v.date : ''
  const features = Array.isArray(v.features)
    ? v.features.map(normalizeEntry).filter((e): e is ChangelogEntry => e !== null)
    : []
  const fixes = Array.isArray(v.fixes)
    ? v.fixes.map(normalizeEntry).filter((e): e is ChangelogEntry => e !== null)
    : []
  return { version, date, title, features, fixes }
}

/**
 * Validate and normalize a fetched changelog document. Returns null if the
 * document has no valid versions at all (a completely empty or malformed
 * payload is treated as "no changelog available", not as an error state).
 */
export function parseChangelog(raw: unknown): ChangelogDoc | null {
  if (raw === null || typeof raw !== 'object') return null
  const doc = raw as Record<string, unknown>
  const versions = Array.isArray(doc.versions)
    ? doc.versions
        .map(normalizeVersion)
        .filter((v): v is NormalizedVersion => v !== null)
    : []
  if (versions.length === 0) return null
  // Enforce newest-first; sort by semver descending.
  const semver = (t: string): [number, number, number] => {
    const m = t.match(/^v(\d+)\.(\d+)\.(\d+)$/)
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0]
  }
  versions.sort((a, b) => {
    const sa = semver(a.version)
    const sb = semver(b.version)
    for (let i = 0; i < 3; i++) {
      if (sa[i] !== sb[i]) return sb[i] - sa[i]
    }
    return 0
  })
  return {
    generatedAt: typeof doc.generatedAt === 'string' ? doc.generatedAt : '',
    versions,
  }
}
