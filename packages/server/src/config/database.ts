import { DataSource, DataSourceOptions } from 'typeorm';
import { join } from 'node:path';
import { User } from '../entities/user.entity.js';
import { Group } from '../entities/group.entity.js';
import { Role } from '../entities/role.entity.js';
import { FormDefinition } from '../entities/form-definition.entity.js';
import { ProcessDefinition } from '../entities/process-definition.entity.js';
import { TaskDefinition } from '../entities/task-definition.entity.js';
import { Task } from '../entities/task.entity.js';
import { SignalOutbox } from '../entities/signal-outbox.entity.js';
import { Attachment } from '../entities/attachment.entity.js';
import { Case } from '../entities/case.entity.js';
import { ApiKey } from '../entities/api-key.entity.js';
import { CaseComment } from '../entities/case-comment.entity.js';
import { CaseEvent } from '../entities/case-event.entity.js';
import { TaskMessage } from '../entities/task-message.entity.js';

const isProduction = process.env.NODE_ENV === 'production';

export const dataSourceOptions: DataSourceOptions = {
  type: 'postgres',
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: parseInt(process.env.DATABASE_PORT ?? '5432', 10),
  database: process.env.DATABASE_NAME ?? 'flowstile',
  username: process.env.DATABASE_USER ?? 'flowstile',
  password: process.env.DATABASE_PASSWORD ?? 'flowstile',
  entities: [User, Group, Role, FormDefinition, ProcessDefinition, TaskDefinition, Task, SignalOutbox, Attachment, Case, ApiKey, CaseComment, CaseEvent, TaskMessage],
  // Migrations are wired ONLY in production, where the server runs compiled JS
  // (node dist/...) and applies them on boot via migrationsRun. Dev and tests
  // use schema sync instead, so the migration files are never loaded there —
  // which also avoids TypeORM eagerly require()-ing the .ts sources under the
  // vitest/ESM test runner. __dirname is dist/config at runtime, so the glob
  // resolves to dist/migrations/*.js.
  migrations: isProduction ? [join(__dirname, '..', 'migrations', '*.js')] : [],
  synchronize: !isProduction,
  migrationsRun: isProduction,
  logging: !isProduction,
};

// Exported for TypeORM CLI (db:generate, db:migrate)
export const AppDataSource = new DataSource(dataSourceOptions);
