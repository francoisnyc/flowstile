import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';

describe('Metrics endpoint', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('exposes Prometheus metrics: HTTP RED, domain gauges, and default node metrics', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');

    const body = res.body;
    expect(body).toContain('flowstile_http_request_duration_seconds');
    expect(body).toContain('flowstile_signal_outbox_messages');
    expect(body).toContain('flowstile_signal_outbox_oldest_pending_age_seconds');
    expect(body).toContain('flowstile_open_tasks');
    expect(body).toContain('flowstile_oldest_open_task_age_seconds');
    // collectDefaultMetrics is registered
    expect(body).toContain('process_cpu_user_seconds_total');
  });

  it('records requests in the HTTP histogram by templated route', async () => {
    await app.inject({ method: 'GET', url: '/health' });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.body).toMatch(
      /flowstile_http_request_duration_seconds_count\{[^}]*route="\/health"/,
    );
  });

  it('is excluded from the OpenAPI document (ops endpoint, not API contract)', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs/json' });
    const spec = JSON.parse(res.body);
    expect(spec.paths['/metrics']).toBeUndefined();
  });
});
