import { defineConfig, devices } from '@playwright/test'

/**
 * E2E tests run against the production build (vite preview on :4173).
 * The app is fully offline — all data/images come from public/, so the
 * specs also assert zero requests ever reach mealime.com hosts.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  testTimeout: 60_000,
  workers: process.env.CI ? 2 : undefined,
  // CI runs sharded (--shard=N/T) so the blob reporter is required — each
  // shard writes a blob the merge-gate job combines. Local runs keep list.
  reporter: process.env.CI
    ? [['blob']]
    : [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
    // Components use data-test="..." rather than the data-testid default.
    testIdAttribute: 'data-test',
  },
  projects: [
    { name: 'Desktop Chrome', use: { ...devices['Desktop Chrome'] } },
    { name: 'Pixel 7', use: { ...devices['Pixel 7'] } },
  ],
  webServer: [
    {
      command: 'bun run preview',
      url: 'http://localhost:4173',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      // Live-room relay (zero-dep, Bun native WebSocket): the app talks to it
      // through the /ws proxy. The brute-force throttle is server-side state,
      // keyed per IP — and every parallel Playwright worker shares ONE IP, so
      // the 30/min default starves the suite (32 failures on main, v0.12.0
      // CI). Tests are not the threat model: lift the cap for the spawned
      // instance only (prod default 30 stands).
      command: 'RELAY_ATTEMPT_LIMIT=100000 bun server/relay.ts',
      url: 'http://localhost:8081',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
})
