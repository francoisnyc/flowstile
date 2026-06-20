import 'reflect-metadata';
import 'dotenv/config';
import bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from './config/database.js';
import { Role } from './entities/role.entity.js';
import { User } from './entities/user.entity.js';

// Production first-run bootstrap: ensure the two built-in roles exist and create
// one admin user from env. Unlike the dev seed, this NEVER truncates and adds no
// demo data — it is safe to run against a live database and is idempotent.
//
//   NODE_ENV=production ADMIN_EMAIL=you@org.com ADMIN_PASSWORD=... \
//     node dist/bootstrap.js
//
// (Connecting with NODE_ENV=production also applies any pending migrations.)

const ADMIN_PERMISSIONS = [
  'forms:write',
  'processes:write',
  'processes:start',
  'tasks:read',
  'tasks:write',
  'tasks:manage',
  'cases:read',
  'users:manage',
];
const TASK_USER_PERMISSIONS = ['tasks:read', 'tasks:write', 'processes:start'];

async function ensureRole(db: DataSource, name: string, permissions: string[]): Promise<Role> {
  const repo = db.getRepository(Role);
  const existing = await repo.findOne({ where: { name } });
  if (existing) return existing;
  const role = await repo.save({ name, permissions });
  console.log(`  + role '${name}'`);
  return role;
}

async function bootstrap(): Promise<void> {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD must be set to bootstrap an admin user');
  }

  const db = new DataSource(dataSourceOptions);
  await db.initialize();
  try {
    const adminRole = await ensureRole(db, 'admin', ADMIN_PERMISSIONS);
    await ensureRole(db, 'task-user', TASK_USER_PERMISSIONS);

    const userRepo = db.getRepository(User);
    const existing = await userRepo.findOne({ where: { email } });
    if (existing) {
      console.log(`  = admin user '${email}' already exists (unchanged)`);
    } else {
      const passwordHash = await bcrypt.hash(password, 10);
      await userRepo.save({
        email,
        displayName: process.env.ADMIN_DISPLAY_NAME ?? email,
        passwordHash,
        roles: [adminRole],
      });
      console.log(`  + admin user '${email}'`);
    }
    console.log('Bootstrap complete.');
  } finally {
    await db.destroy();
  }
}

bootstrap().catch((err) => {
  console.error('Bootstrap failed:', err);
  process.exit(1);
});
