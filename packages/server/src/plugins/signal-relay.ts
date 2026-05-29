import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import { processOutboxBatch, type SignalDeliverer } from '../signals/outbox.js';

// Background loop that drains the signal outbox. Starts only when a live
// Temporal client is available; otherwise outbox rows accumulate as pending
// and are delivered once the server restarts with Temporal reachable.
export default fp(async (app: FastifyInstance) => {
  const client = app.temporal;
  if (!client) {
    app.log.info('Signal relay not started — no Temporal client');
    return;
  }

  const pollMs = parseInt(process.env.SIGNAL_RELAY_POLL_MS ?? '2000', 10);

  const deliver: SignalDeliverer = async (workflowId, signalName, payload) => {
    const handle = client.workflow.getHandle(workflowId);
    if (payload == null) {
      await handle.signal(signalName);
    } else {
      await handle.signal(signalName, payload);
    }
  };

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async () => {
    if (stopped) return;
    try {
      await processOutboxBatch(app.db, deliver, app.log);
    } catch (err) {
      app.log.error({ err }, 'Signal relay batch failed');
    }
    if (!stopped) {
      timer = setTimeout(tick, pollMs);
    }
  };

  // Kick off after ready so DB and Temporal are fully wired.
  app.addHook('onReady', async () => {
    app.log.info({ pollMs }, 'Signal relay started');
    timer = setTimeout(tick, pollMs);
  });

  app.addHook('onClose', async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  });
});
