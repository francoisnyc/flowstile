import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import client from 'prom-client';
import { OutboxStatus, TaskStatus } from '../common/enums.js';

// Prometheus metrics: RED on the HTTP layer plus a few domain gauges that the
// generic HTTP metrics can't see — signal-outbox health (a stuck signal silently
// hangs workflows) and open-task age (the human SLA). The gauges are computed at
// scrape time from the database: a read-only observability layer, never a write
// path that could affect execution. /metrics is unauthenticated (like /health) —
// restrict it at the network layer in production.
export default fp(async (app: FastifyInstance) => {
  const register = new client.Registry();
  register.setDefaultLabels({ service: 'flowstile-server' });
  client.collectDefaultMetrics({ register });

  const httpDuration = new client.Histogram({
    name: 'flowstile_http_request_duration_seconds',
    help: 'HTTP request duration in seconds, by method/route/status.',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [register],
  });

  app.addHook('onResponse', async (req, reply) => {
    // routeOptions.url is the templated path (e.g. /tasks/:id) — bounded
    // cardinality. Unmatched requests (404) collapse to a single series.
    const route = req.routeOptions?.url ?? 'unmatched';
    httpDuration.observe(
      { method: req.method, route, status: reply.statusCode },
      reply.elapsedTime / 1000,
    );
  });

  // ── Domain gauges (refreshed per scrape from the DB) ────────────────────────
  const outboxMessages = new client.Gauge({
    name: 'flowstile_signal_outbox_messages',
    help: 'Signal-outbox rows by status. pending backing up or failed > 0 means workflows may be hung.',
    labelNames: ['status'] as const,
    registers: [register],
  });
  const outboxOldestPending = new client.Gauge({
    name: 'flowstile_signal_outbox_oldest_pending_age_seconds',
    help: 'Age of the oldest pending signal (0 if none). Rising means delivery is stuck.',
    registers: [register],
  });
  const openTasks = new client.Gauge({
    name: 'flowstile_open_tasks',
    help: 'Open (created/claimed) tasks by status — the inbox backlog.',
    labelNames: ['status'] as const,
    registers: [register],
  });
  const oldestOpenTask = new client.Gauge({
    name: 'flowstile_oldest_open_task_age_seconds',
    help: 'Age of the oldest open task (0 if none) — the human SLA signal.',
    registers: [register],
  });

  const OPEN_STATUSES = [TaskStatus.CREATED, TaskStatus.CLAIMED];

  async function refreshDomainGauges(): Promise<void> {
    const db = app.db;

    const outboxRows: Array<{ status: string; count: number }> = await db.query(
      'SELECT status, count(*)::int AS count FROM signal_outbox GROUP BY status',
    );
    const seenOutbox = new Set(outboxRows.map((r) => r.status));
    for (const row of outboxRows) outboxMessages.set({ status: row.status }, Number(row.count));
    for (const s of Object.values(OutboxStatus)) if (!seenOutbox.has(s)) outboxMessages.set({ status: s }, 0);

    const outboxAge: Array<{ age: number }> = await db.query(
      `SELECT COALESCE(EXTRACT(EPOCH FROM (now() - min("createdAt"))), 0)::float AS age
         FROM signal_outbox WHERE status = $1`,
      [OutboxStatus.PENDING],
    );
    outboxOldestPending.set(Number(outboxAge[0]?.age ?? 0));

    const taskRows: Array<{ status: string; count: number }> = await db.query(
      'SELECT status, count(*)::int AS count FROM tasks WHERE status IN ($1, $2) GROUP BY status',
      OPEN_STATUSES,
    );
    const seenTasks = new Set(taskRows.map((r) => r.status));
    for (const row of taskRows) openTasks.set({ status: row.status }, Number(row.count));
    for (const s of OPEN_STATUSES) if (!seenTasks.has(s)) openTasks.set({ status: s }, 0);

    const taskAge: Array<{ age: number }> = await db.query(
      `SELECT COALESCE(EXTRACT(EPOCH FROM (now() - min("createdAt"))), 0)::float AS age
         FROM tasks WHERE status IN ($1, $2)`,
      OPEN_STATUSES,
    );
    oldestOpenTask.set(Number(taskAge[0]?.age ?? 0));
  }

  app.get('/metrics', { schema: { hide: true } }, async (_req, reply) => {
    try {
      await refreshDomainGauges();
    } catch (err) {
      app.log.warn({ err }, 'metrics: domain gauge refresh failed');
    }
    reply.header('Content-Type', register.contentType);
    return register.metrics();
  });
});
