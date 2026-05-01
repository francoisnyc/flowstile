import { execSync } from 'child_process';
import path from 'path';

export default function globalSetup() {
  const serverDir = path.resolve(__dirname, '..', 'packages', 'server');
  console.log('Re-seeding database...');
  execSync('npx tsx src/seed.ts', { cwd: serverDir, stdio: 'pipe' });
  console.log('Seed complete.');
}
