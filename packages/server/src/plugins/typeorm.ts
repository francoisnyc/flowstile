import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../config/database.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: DataSource;
  }
}

export default fp(async (app: FastifyInstance) => {
  const dataSource = new DataSource(dataSourceOptions);
  await dataSource.initialize();

  await dataSource.query(`
    CREATE INDEX IF NOT EXISTS idx_tasks_input_data_gin ON tasks USING GIN ("inputData" jsonb_path_ops);
    CREATE INDEX IF NOT EXISTS idx_tasks_context_data_gin ON tasks USING GIN ("contextData" jsonb_path_ops);
    CREATE INDEX IF NOT EXISTS idx_tasks_submission_data_gin ON tasks USING GIN ("submissionData" jsonb_path_ops);
  `);

  app.decorate('db', dataSource);

  app.addHook('onClose', async () => {
    await dataSource.destroy();
  });
});
