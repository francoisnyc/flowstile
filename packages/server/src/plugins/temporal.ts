import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import { Connection, Client } from '@temporalio/client';

declare module 'fastify' {
  interface FastifyInstance {
    temporal: Client | null;
  }
}

export default fp(async (app: FastifyInstance) => {
  const address = process.env.TEMPORAL_ADDRESS;
  let client: Client | null = null;

  if (address) {
    try {
      const connection = await Connection.connect({ address });
      client = new Client({ connection });
    } catch (err) {
      app.log.warn({ err }, 'Could not connect to Temporal — task completion signals disabled');
    }
  }

  app.decorate('temporal', client);

  app.addHook('onClose', async () => {
    if (client) await client.connection.close();
  });
});
