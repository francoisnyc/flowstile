import { createHash, randomBytes } from 'node:crypto';

// All Flowstile API keys carry this prefix so the auth layer can distinguish
// them from JWTs presented in the same Authorization: Bearer header.
export const API_KEY_PREFIX = 'fsk_';

// Generates a new opaque API key token. The token is shown to the caller once;
// only its hash is persisted.
export function generateApiKeyToken(): string {
  return API_KEY_PREFIX + randomBytes(32).toString('base64url');
}

// SHA-256 hex digest used as the stored, lookup-able representation of a token.
export function hashApiKey(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// Returns true if a presented bearer token looks like a Flowstile API key
// (vs a JWT), so the auth layer can route it to the API-key path.
export function looksLikeApiKey(token: string): boolean {
  return token.startsWith(API_KEY_PREFIX);
}
