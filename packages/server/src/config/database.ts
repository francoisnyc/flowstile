import { DataSource, DataSourceOptions } from 'typeorm';
import { User } from '../entities/user.entity.js';
import { Group } from '../entities/group.entity.js';
import { Role } from '../entities/role.entity.js';
import { FormDefinition } from '../entities/form-definition.entity.js';
import { ProcessDefinition } from '../entities/process-definition.entity.js';
import { TaskDefinition } from '../entities/task-definition.entity.js';
import { Task } from '../entities/task.entity.js';

export const dataSourceOptions: DataSourceOptions = {
  type: 'postgres',
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: parseInt(process.env.DATABASE_PORT ?? '5432', 10),
  database: process.env.DATABASE_NAME ?? 'flowstile',
  username: process.env.DATABASE_USER ?? 'flowstile',
  password: process.env.DATABASE_PASSWORD ?? 'flowstile',
  entities: [User, Group, Role, FormDefinition, ProcessDefinition, TaskDefinition, Task],
  migrations: [],
  synchronize: process.env.NODE_ENV === 'development',
  logging: process.env.NODE_ENV !== 'production',
};

// Exported for TypeORM CLI (db:generate, db:migrate)
export const AppDataSource = new DataSource(dataSourceOptions);
