import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { buildAppVersion } from './src/lib/appVersion'

// The live-room relay runs as a separate process (server/relay.mjs, :8081 in
// dev/e2e, the `relay` service behind nginx in production). Both the dev
// server and `vite preview` (used by the e2e suite) proxy /ws to it so the
// browser only ever talks to the web origin.
const relayProxy = {
  '/ws': {
    target: 'http://localhost:8081',
    ws: true,
  },
}

// The app version is a BUILD-TIME fact (ADR-0039): a release build shows the
// tag itself, everything else shows <latest-tag>-<branch>-<short-sha>. CI
// environments are authoritative when present (a shallow checkout would lie
// to git); locally the git repo itself answers; with no facts at all the
// header degrades to `dev`.
function gitOut(args: string): string | null {
  try {
    return (
      execSync(`git ${args}`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null
    )
  } catch {
    return null
  }
}

const isTagRelease = process.env.GITHUB_REF_TYPE === 'tag'
// An explicit APP_VERSION (the release workflow's Docker build-arg) is the
// authoritative version: the Docker build has no git metadata and no CI env
// (review #7), so without it the image's header would read `dev`.
const tag =
  process.env.APP_VERSION ||
  (isTagRelease ? process.env.GITHUB_REF_NAME || null : null) ||
  gitOut('describe --tags --abbrev=0')
const branch =
  process.env.GITHUB_HEAD_REF || // PR events carry the head branch, not NN/merge
  (process.env.GITHUB_REF_TYPE === 'branch' ? process.env.GITHUB_REF_NAME || null : null) ||
  gitOut('rev-parse --abbrev-ref HEAD')
// PR events set GITHUB_SHA to the SYNTHETIC merge commit (refs/pull/N/merge),
// which exists nowhere in the branch history (review #9) — the build env
// carries the PR's head sha instead.
const shaFull = process.env.PR_HEAD_SHA || process.env.GITHUB_SHA || gitOut('rev-parse HEAD')
const sha = shaFull ? shaFull.slice(0, 7) : null

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  server: { proxy: relayProxy },
  preview: { proxy: relayProxy },
  define: {
    __APP_VERSION__: JSON.stringify(
      buildAppVersion({ tag, branch, sha, isRelease: isTagRelease }),
    ),
  },
})
