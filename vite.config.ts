import { execSync } from 'node:child_process'
import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { buildAppVersion } from './src/lib/appVersion'
// The dependency-free module, not ./src/lib/seo: seo.ts reaches the DOM
// types (images.ts) and importing it here would break vue-tsc -b.
import { DEFAULT_SITE_URL } from './src/lib/siteUrl'

// The live-room relay runs as a separate process (server/relay.ts, :8081 in
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

/**
 * The app version as a plain object — ONE computation feeding TWO consumers
 * (ADR-0061 §1): the bundle define (`__APP_VERSION__`) and the emitted
 * `dist/version.json`. A second version formula would drift exactly when it
 * matters.
 */
const appVersionValue = buildAppVersion({ tag, branch, sha, isRelease: isTagRelease })

/**
 * Vite plugin that emits `dist/version.json` at build time and serves it
 * from `configureServer` in dev — so local dev and the e2e preview behave
 * like production (ADR-0061 §1).
 */
function versionJsonPlugin(): Plugin {
  return {
    name: 'version-json',
    generateBundle(this: any) {
      const obj = {
        version: appVersionValue,
        builtAt: new Date().toISOString(),
      }
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify(obj, null, 2) + '\n',
      })
    },
    /**
     * Serve the identical version.json in dev so local dev and the e2e
     * preview behave like production (ADR-0061 §1).
     */
    configureServer(server: any) {
      server.middlewares.use('/version.json', (_req: unknown, res: unknown) => {
        const r = res as { setHeader: (k: string, v: string) => void; end: (s: string) => void }
        r.setHeader('Content-Type', 'application/json')
        r.setHeader('Cache-Control', 'no-cache')
        r.end(
          JSON.stringify({
            version: appVersionValue,
            builtAt: new Date().toISOString(),
          }) + '\n',
        )
      })
    },
  }
}

export default defineConfig({
  plugins: [vue(), tailwindcss(), versionJsonPlugin()],
  server: {
    proxy: relayProxy,
  },
  preview: { proxy: relayProxy },
  define: {
    __APP_VERSION__: JSON.stringify(appVersionValue),
    // The canonical origin for SEO payloads (ADR-0048). A self-hosted build
    // can point every canonical, OG url and JSON-LD @id at its own origin
    // with SITE_URL=…; the prerenderer reads the SAME env var, so the
    // static HTML and the hydrating app can never disagree about it.
    __SITE_URL__: JSON.stringify(
      (process.env.SITE_URL || DEFAULT_SITE_URL).replace(/\/+$/, ''),
    ),
  },
})
