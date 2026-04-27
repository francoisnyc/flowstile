import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['test/integration/**/*.spec.ts'],
    setupFiles: ['test/integration/setup.ts'],
  },
});
