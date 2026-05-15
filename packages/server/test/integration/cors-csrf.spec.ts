import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { createTestUser, TEST_PASSWORD } from './helpers.js';

describe('CORS headers', () => {
  describe('when CORS_ORIGINS is set to a single origin', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      process.env.CORS_ORIGINS = 'https://app.example.com';
      app = await buildApp();
      await app.ready();
    });

    afterAll(async () => {
      delete process.env.CORS_ORIGINS;
      await app.close();
    });

    it('returns CORS headers for a listed origin', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { origin: 'https://app.example.com' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe('https://app.example.com');
      expect(response.headers['access-control-allow-credentials']).toBe('true');
    });

    it('does not return CORS headers for an unlisted origin', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { origin: 'https://evil.example.com' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('handles preflight OPTIONS requests for a listed origin', async () => {
      const response = await app.inject({
        method: 'OPTIONS',
        url: '/health',
        headers: {
          origin: 'https://app.example.com',
          'access-control-request-method': 'GET',
        },
      });

      expect(response.statusCode).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe('https://app.example.com');
      expect(response.headers['access-control-allow-credentials']).toBe('true');
    });
  });

  describe('when CORS_ORIGINS has multiple origins', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      process.env.CORS_ORIGINS = 'https://app.example.com,https://admin.example.com';
      app = await buildApp();
      await app.ready();
    });

    afterAll(async () => {
      delete process.env.CORS_ORIGINS;
      await app.close();
    });

    it('returns CORS headers for the first listed origin', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { origin: 'https://app.example.com' },
      });

      expect(response.headers['access-control-allow-origin']).toBe('https://app.example.com');
    });

    it('returns CORS headers for the second listed origin', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { origin: 'https://admin.example.com' },
      });

      expect(response.headers['access-control-allow-origin']).toBe('https://admin.example.com');
    });

    it('does not return CORS headers for an unlisted origin', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { origin: 'https://other.example.com' },
      });

      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('when CORS_ORIGINS is unset', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      delete process.env.CORS_ORIGINS;
      app = await buildApp();
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it('does not return CORS headers for any origin', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { origin: 'https://app.example.com' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('when CORS_ORIGINS is empty string', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      process.env.CORS_ORIGINS = '';
      app = await buildApp();
      await app.ready();
    });

    afterAll(async () => {
      delete process.env.CORS_ORIGINS;
      await app.close();
    });

    it('does not return CORS headers for any origin', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { origin: 'https://app.example.com' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });
  });
});

describe('CSRF origin validation', () => {
  describe('when CORS_ORIGINS is configured', () => {
    let app: FastifyInstance;
    let cookie: string;
    let bearerToken: string;

    beforeAll(async () => {
      process.env.CORS_ORIGINS = 'https://app.example.com';
      app = await buildApp();
      await app.ready();

      // Create a test user and log in with an allowed Origin header so CSRF does not block login
      const user = await createTestUser(app);
      const loginRes = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: user.email, password: TEST_PASSWORD },
        headers: { origin: 'https://app.example.com' },
      });
      const setCookie = loginRes.headers['set-cookie'];
      cookie = Array.isArray(setCookie) ? setCookie[0] : (setCookie ?? '');

      // Extract the raw JWT from the cookie for use as a Bearer token
      const match = cookie.match(/flowstile_token=([^;]+)/);
      bearerToken = match ? match[1] : '';
    });

    afterAll(async () => {
      delete process.env.CORS_ORIGINS;
      await app.close();
    });

    it('allows POST from a listed origin with cookie auth', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: {
          cookie,
          origin: 'https://app.example.com',
        },
      });

      // 204 means CSRF passed and auth succeeded; any non-403 status means CSRF did not block it
      expect(response.statusCode).not.toBe(403);
    });

    it('blocks POST from an unlisted origin with cookie auth', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: {
          cookie,
          origin: 'https://evil.example.com',
        },
      });

      expect(response.statusCode).toBe(403);
    });

    it('blocks POST with no Origin or Referer when using cookie auth', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: { cookie },
      });

      expect(response.statusCode).toBe(403);
    });

    it('allows POST with valid Bearer token and no Origin header (CSRF bypassed)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: {
          authorization: `Bearer ${bearerToken}`,
        },
      });

      // CSRF check is bypassed for valid Bearer tokens; should not return 403
      expect(response.statusCode).not.toBe(403);
    });

    it('blocks (falls through) POST with invalid Bearer token and no Origin', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: {
          authorization: 'Bearer invalid.token.here',
        },
      });

      // Invalid Bearer falls through to origin check — no origin present → 403
      expect(response.statusCode).toBe(403);
    });

    it('skips CSRF validation for GET requests entirely', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/health',
        // No Origin header, no cookie — CSRF must not block GET
      });

      expect(response.statusCode).toBe(200);
    });

    it('allows POST with Referer header (no Origin) from a listed origin', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: {
          cookie,
          referer: 'https://app.example.com/some/page',
        },
      });

      // CSRF should pass because Referer origin matches allowlist
      expect(response.statusCode).not.toBe(403);
    });

    it('blocks POST with Referer header from an unlisted origin (no Origin)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: {
          cookie,
          referer: 'https://evil.example.com/some/page',
        },
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe('when CORS_ORIGINS is not configured', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      delete process.env.CORS_ORIGINS;
      app = await buildApp();
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it('is a no-op — POST with no Origin succeeds (CSRF not enforced)', async () => {
      // Without CORS_ORIGINS, CSRF plugin is disabled entirely
      const response = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'nobody@example.com', password: 'wrong' },
        // No Origin header at all
      });

      // Should get 401 (invalid creds) not 403 (CSRF block)
      expect(response.statusCode).toBe(401);
    });
  });
});
