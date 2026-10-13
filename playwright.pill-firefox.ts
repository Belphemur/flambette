import { defineConfig, devices } from '@playwright/test'
import base from './playwright.config'

/**
 * Firefox-parity runner for the "Cooked this?" pill (ADR-0083 pill
 * round). CI installs chromium only (`bunx playwright install
 * --with-deps chromium`), so a Firefox project cannot live in the
 * sharded CI config without breaking every shard; this auxiliary runner
 * executes ONLY the pill spec on the real Firefox project:
 *
 *   bunx playwright install firefox   # once
 *   bunx playwright test e2e/cooked-pill.spec.ts \
 *     --config=playwright.pill-firefox.ts
 *
 * Everything else (webServer, testIdAttribute, offline enforcement) is
 * inherited from the base config.
 */
export default defineConfig({
  ...base,
  testMatch: /cooked-pill\.spec\.ts$/,
  projects: [{ name: 'Desktop Firefox', use: { ...devices['Desktop Firefox'] } }],
})