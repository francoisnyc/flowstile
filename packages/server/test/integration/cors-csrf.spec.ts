import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';

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
