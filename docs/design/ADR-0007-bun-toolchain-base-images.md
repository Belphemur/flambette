# ADR-0007: Bun-first toolchain and unpinned base images

- **Status:** accepted
- **Date:** 2026-09-27 (phase 8)
- **Decides:** build toolchain, CI runner, and base-image versioning

## Context

The relay image carried 244 MB of node just to serve ~200 lines of
WebSocket code. The web image's other layers (apk curl, npm ci) added
churn. The owner also set a standing rule originally as "Node LTS
everywhere" to avoid actions/node-20-deprecation-class warnings.

## Decision

- **Bun 1.x** is the toolchain: `bun.lock` (text, committed) replaces
  `package-lock.json`; CI uses `oven-sh/setup-bun@v2` +
  `bun install --frozen-lockfile`; e2e runs `bunx playwright` (no node
  fallback needed); the Dockerfile build stage is `oven/bun:1-alpine`.
- **The web serve stage stays `nginx:alpine`** (nginx serves the
  static catalog; swapping it saved nothing).
- **Base-image policy (generalized owner rule): never pin a major.**
  `oven/bun:1-alpine`, `nginx:alpine`, `bun-version: latest`. Track
  lts/latest, avoid deprecation-warning churn.
- Web image final size unchanged (its ~200 MB is the catalog);
  precompression of text assets was measured (+6.6 MB image growth
  from .gz copies) and rejected.

## Consequences

- `npm` scripts keep working through `bun run x`, but contributors'
  docs and AGENTS.md reference bun commands.
- Playwright stays runnable under bun — if a future Playwright
  version breaks under bun, the escape is a single CI step, not a
  rollback of the whole migration.

## Alternatives considered

- **node:lts-slim for the relay** — measured; bun base wins anyway.
- **Pin everything for reproducibility** — rejected by owner rule;
  bun.lock pins the JS dep graph, base images track lts.
