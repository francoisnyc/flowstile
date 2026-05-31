import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:5173',
  },
  // webServer is only used when CI=true. Locally, rely on an already-running
  // stack (reuseExistingServer: true) so `pnpm dev` stays your dev workflow.
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
    {
      command: 'pnpm --filter @flowstile/worker dev',
      // No health-check URL; wait for the worker's own startup log.
      stdout: 'Flowstile worker started',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
