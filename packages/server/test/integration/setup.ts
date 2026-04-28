import 'reflect-metadata';

process.env.NODE_ENV ??= 'test';
process.env.JWT_SECRET ??= 'test-jwt-secret-minimum-32-characters-long';

// Integration tests require Docker PostgreSQL running:
//   docker compose up -d postgres
//
// Run with: pnpm test:integration
