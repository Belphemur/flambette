/**
 * Build-time app version (ADR-0039).
 *
 * Release builds (a `v*` tag) show the tag itself; preview and local builds
 * show `<latest-tag>-<branch>-<short-sha>` so the header always tells you
 * exactly what is running. `vite.config.ts` gathers the git facts and bakes
 * the result as the `__APP_VERSION__` define; the header renders it
 * (`data-test="app-version"`). This module stays PURE so the formatter has
 * unit coverage and `vite.config.ts` only does the git/env plumbing.
 */
export interface AppVersionInputs {
  /** Latest `v*` tag reachable from the build, e.g. `v1.2.3`. */
  tag: string | null
  /** Branch or PR head branch, e.g. `main`, `feat/cf-ci-release`. */
  branch: string | null
  /** Short commit id, e.g. `abc1234`. */
  sha: string | null
  /** True when this build IS the release — built from the tag itself. */
  isRelease: boolean
}

export function buildAppVersion({
  tag,
  branch,
  sha,
  isRelease,
}: AppVersionInputs): string {
  // A release build IS the tag — no suffix, the header reads `v1.2.3`.
  if (isRelease && tag) return tag
  // Preview / CI branch build: tag-branch-sha, per the release model.
  if (tag && branch && sha) return `${tag}-${branch}-${sha}`
  // No tag reachable yet (fresh repo): still identify the exact commit.
  if (sha) return `dev-${sha}`
  // No git facts at all (e.g. a vendored dist): degrade honestly.
  return 'dev'
}

// The version vite.config bakes as the `__APP_VERSION__` define. Declared
// here (not in vite-env.d.ts) so the declaration lives with its only
// consumer; the `typeof` guard keeps plain bun imports (unit tests, tools)
// working without the define — `typeof` never throws on an undeclared name.
declare const __APP_VERSION__: string
export const appVersion: string =
  typeof __APP_VERSION__ === 'undefined' ? 'dev' : __APP_VERSION__
