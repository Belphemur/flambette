import path from 'node:path'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

const wrangler = { configPath: path.join(import.meta.dirname, 'wrangler.jsonc') }

/**
 * Durable Object specs (ADR-0038 §7): the Room object driven for real in
 * workerd, through the entry's fetch, so the suite covers the whole
 * upgrade path — intent parsing, throttle, DO routing — and not just the
 * DO class in isolation.
 *
 * Two projects, because the create/join throttle is a per-isolate bucket
 * and the two concerns want OPPOSITE limits:
 *
 * - `room` raises RELAY_ATTEMPT_LIMIT so the ~30 upgrades the lifecycle
 *   scenarios need never trip it (mirrors the e2e suite's raised limit);
 * - `throttle` drops it to 3 so the boundary is reachable in three dials.
 *
 * Each project is its own test FILE, and each test file gets its own
 * isolate, so the bucket is fresh where it is being measured and unused
 * where it is being avoided.
 *
 * Run with `bun run test:worker`. This config is deliberately NOT wired
 * into `bun run test:unit`: those specs are Bun-test over src/, these are
 * vitest over workerd, and the two runners disagree about globals.
 */
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            wrangler,
            miniflare: { bindings: { RELAY_ATTEMPT_LIMIT: '100000' } },
          }),
        ],
        test: {
          name: 'room',
          include: ['worker/room.test.ts'],
        },
      },
      {
        plugins: [
          cloudflareTest({
            wrangler,
            miniflare: { bindings: { RELAY_ATTEMPT_LIMIT: '3' } },
          }),
        ],
        test: {
          name: 'throttle',
          include: ['worker/relayThrottle.test.ts'],
        },
      },
    ],
  },
})