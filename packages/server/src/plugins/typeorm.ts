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

  app.decorate('db', dataSource);

  app.addHook('onClose', async () => {
    await dataSource.destroy();
  });
});
