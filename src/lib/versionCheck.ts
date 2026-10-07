/**
 * Pure version check (ADR-0061 §2).
 *
 * Fetches same-origin `version.json` and compares the running `appVersion`
 * against it. Answers a tri-state question:
 *   - `same` — strings equal: nothing to say.
 *   - `stale` — strings differ: a newer bundle is deployed.
 *   - `unknown` — fetch failed, timed out, or the JSON did not validate:
 *     say nothing.
 *
 * The comparison is string INEQUALITY, deliberately not semver ordering.
 * A deployed change is by definition a new bundle worth reloading — a
 * preview deploy, a same-tag hotfix rebuild and a real version bump all
 * compare cleanly as strings. `unknown` never nags: a self-hosted user
 * mid-outage must not get a scary banner for a check that merely could not
 * run.
 *
 * Pure — no Vue/Pinia/fetch in the comparison logic; the fetch is
 * parameterized so the unit tests can inject any response.
 */

export type VersionState = 'same' | 'stale' | 'unknown'

export interface VersionCheckResult {
  state: VersionState
  running: string
  deployed: string | null
}

function validateShape(raw: unknown): string | null {
  if (raw === null || typeof raw !== 'object') return 'not an object'
  const v = raw as Record<string, unknown>
  if (typeof v.version !== 'string' || !v.version) return 'missing version string'
  return null
}

/**
 * Compare the running version against a deployed version string.
 * Pure — no I/O, just string inequality (ADR-0061 §2).
 */
export function compareVersions(running: string, deployed: string | null): VersionState {
  if (deployed === null) return 'unknown'
  return running === deployed ? 'same' : 'stale'
}

export interface FetchVersionOptions {
  /** The version string baked into the running bundle (`appVersion`). */
  running: string
  /** Custom fetch function for testability; defaults to global fetch. */
  fetch?: typeof globalThis.fetch
  /** Timeout in ms for the fetch; defaults to 5000. */
  timeoutMs?: number
}

/**
 * Fetch `version.json` (cache: 'no-store') and answer the tri-state question.
 * The caller provides the running version; this function does NOT derive it,
 * keeping the single-source-of-truth rule intact (ADR-0061 §1).
 */
export async function checkVersion({
  running,
  fetch: fetchFn = globalThis.fetch.bind(globalThis),
  timeoutMs = 5000,
}: FetchVersionOptions): Promise<VersionCheckResult> {
  let controller: AbortController | undefined
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    controller = new AbortController()
    timeoutId = setTimeout(() => controller?.abort(), timeoutMs)
    const res = await fetchFn('/version.json', { cache: 'no-store', signal: controller.signal })
    if (!res.ok) return { state: 'unknown', running, deployed: null }
    let raw: unknown
    try {
      raw = await res.json()
    } catch {
      return { state: 'unknown', running, deployed: null }
    }
    if (validateShape(raw)) return { state: 'unknown', running, deployed: null }
    const deployed = (raw as Record<string, unknown>).version as string
    return {
      state: compareVersions(running, deployed),
      running,
      deployed,
    }
  } catch {
    return { state: 'unknown', running, deployed: null }
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
  }
}
