import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export default fp(async (app: FastifyInstance) => {
  const raw = process.env.CORS_ORIGINS ?? '';
  const allowedOrigins = raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  // Skip entirely when CORS_ORIGINS is not configured
  if (allowedOrigins.length === 0) {
    return;
  }

  app.addHook('onRequest', async (request, reply) => {
    // Skip non-mutating methods
    if (!MUTATING_METHODS.has(request.method)) {
      return;
    }

    // Check if the request has a valid Bearer token — Bearer tokens are CSRF-proof
    const auth = request.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      const token = auth.slice(7);
      try {
        await app.jwt.verify(token);
        // Valid Bearer token — skip CSRF check
        return;
      } catch {
        // Invalid Bearer token — fall through to origin check
      }
    }

    // Resolve effective origin from Origin header, or extract from Referer
    let effectiveOrigin: string | undefined;

    const originHeader = request.headers.origin;
    if (originHeader) {
      effectiveOrigin = originHeader;
    } else {
      const referer = request.headers.referer;
      if (referer) {
        try {
          const url = new URL(referer);
          effectiveOrigin = url.origin;
        } catch {
          // Invalid Referer — treat as missing
        }
      }
    }

    if (!effectiveOrigin) {
      return reply.code(403).send({ error: 'Forbidden: missing Origin or Referer' });
    }

    // Build allowlist: CORS_ORIGINS + server's own origin
    const serverOrigin = (() => {
      const host = request.headers.host ?? 'localhost';
      const proto = request.headers['x-forwarded-proto'] ?? 'http';
      return `${proto}://${host}`;
    })();

    const allowlist = [...allowedOrigins, serverOrigin];

    if (!allowlist.includes(effectiveOrigin)) {
      return reply.code(403).send({ error: 'Forbidden: origin not allowed' });
    }
  });
});
