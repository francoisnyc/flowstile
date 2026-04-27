import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { createTestUser, loginAs, authed, cleanupTestData, TEST_PASSWORD } from './helpers.js';

describe('Auth routes', () => {
  let app: FastifyInstance;
  let userEmail: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    const user = await createTestUser(app);
    userEmail = user.email;
  });

  afterAll(async () => {
    await cleanupTestData(app);
    await app.close();
  });

  describe('POST /auth/login', () => {
    it('returns user and sets cookie on valid credentials', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: userEmail, password: TEST_PASSWORD },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ email: string; roles: unknown[]; groups: unknown[] }>();
      expect(body.email).toBe(userEmail);
      expect(Array.isArray(body.roles)).toBe(true);
      expect(Array.isArray(body.groups)).toBe(true);
      expect(res.headers['set-cookie']).toBeDefined();
    });

    it('returns 401 on wrong password', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: userEmail, password: 'wrong-password' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 401 on unknown email', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'nobody@example.com', password: TEST_PASSWORD },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /auth/me', () => {
    it('returns current user when authenticated', async () => {
      const cookie = await loginAs(app, userEmail);
      const res = await authed(app, cookie, { method: 'GET', url: '/auth/me' });

      expect(res.statusCode).toBe(200);
      expect(res.json<{ email: string }>().email).toBe(userEmail);
    });

    it('returns 401 when not authenticated', async () => {
      const res = await app.inject({ method: 'GET', url: '/auth/me' });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /auth/logout', () => {
    it('clears the session cookie', async () => {
      const cookie = await loginAs(app, userEmail);

      const logoutRes = await authed(app, cookie, { method: 'POST', url: '/auth/logout' });
      expect(logoutRes.statusCode).toBe(204);

      // Cookie should be cleared (Max-Age=0 or Expires in the past)
      const setCookie = logoutRes.headers['set-cookie'] as string | undefined;
      expect(setCookie).toMatch(/flowstile_token=;/);
    });

    it('returns 401 when not authenticated', async () => {
      const res = await app.inject({ method: 'POST', url: '/auth/logout' });
      expect(res.statusCode).toBe(401);
    });
  });
});
