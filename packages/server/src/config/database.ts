import { DataSource, DataSourceOptions } from 'typeorm';

export const dataSourceOptions: DataSourceOptions = {
  type: 'postgres',
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: parseInt(process.env.DATABASE_PORT ?? '5432', 10),
  database: process.env.DATABASE_NAME ?? 'flowstile',
  username: process.env.DATABASE_USER ?? 'flowstile',
  password: process.env.DATABASE_PASSWORD ?? 'flowstile',
  entities: [__dirname + '/../entities/*.entity{.ts,.js}'],
  migrations: [__dirname + '/../migrations/*{.ts,.js}'],
  synchronize: process.env.NODE_ENV === 'development',
  logging: process.env.NODE_ENV !== 'production',
};

// Exported for TypeORM CLI (db:generate, db:migrate)
export const AppDataSource = new DataSource(dataSourceOptions);
