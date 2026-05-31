import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  // Always emit an HTML report so CI artifact upload has something to save.
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    baseURL: 'http://localhost:5173',
  },
  // webServer manages server + UI startup when CI=true.
  // The worker is started separately in CI (after Temporal is healthy) so it
  // isn't subject to Playwright's pre-test timeout. Locally, reuseExistingServer
  // means your existing `pnpm dev` stack is used as-is.
  webServer: [
    {
      command: 'pnpm --filter @flowstile/server dev',
      url: 'http://localhost:3000/health',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: 'pnpm --filter @flowstile/ui dev',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
