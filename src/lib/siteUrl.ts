/**
 * The canonical origin for every SEO payload (ADR-0048) — in its own
 * dependency-free module because it is read from TWO type-checked projects:
 * the app (`src/**`, DOM lib) and `vite.config.ts` (`tsconfig.node.json`,
 * no DOM). Sharing it through `src/lib/seo.ts` would drag that module's DOM
 * dependency into the node project and break `vue-tsc -b`; hard-coding the
 * literal in the config would let the two drift, which is exactly the
 * disagreement this ADR exists to prevent.
 */
export const DEFAULT_SITE_URL = 'https://flambette.app'