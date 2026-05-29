import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import { Connection, Client } from '@temporalio/client';

declare module 'fastify' {
  interface FastifyInstance {
    temporal: Client | null;
    // True when Temporal is configured (TEMPORAL_ADDRESS set), even if the
    // connection is momentarily down. Gates whether signals are enqueued to
    // the outbox for durable delivery.
    temporalEnabled: boolean;
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
      app.log.warn({ err }, 'Could not connect to Temporal now — signals will be retried from the outbox');
    }
  }

  app.decorate('temporal', client);
  app.decorate('temporalEnabled', Boolean(address));

  app.addHook('onClose', async () => {
    if (client) await client.connection.close();
  });
});
