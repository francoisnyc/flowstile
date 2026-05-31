import { execSync } from 'child_process';
import path from 'path';

export default function globalSetup() {
  // __dirname is only defined in CJS; derive the project root via import.meta if needed.
  // Playwright compiles this with its own bundler so __dirname is available.
  const root = path.resolve(__dirname, '..');
  console.log('Re-seeding database...');
  // Use pnpm so the workspace-managed tsx binary is on PATH, not npx which
  // can't see pnpm-hoisted executables in CI.
  execSync('pnpm --filter @flowstile/server db:seed', {
    cwd: root,
    stdio: 'inherit', // surface seed errors in the Playwright output
  });
  console.log('Seed complete.');
}
