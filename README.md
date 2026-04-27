# Flowstile

Open-source human-task inbox and form designer for [Temporal.io](https://temporal.io) workflows. Create forms, assign tasks to humans, and wire the results back into durable workflows via signals.

**Status:** Foundation (in development)

## Quick Start

```bash
# Prerequisites: Docker, Node.js 22+, corepack
corepack enable
git clone <repo-url> && cd flowstile
cp .env.example .env
pnpm install
docker compose up -d postgres
pnpm dev
```

Server starts at http://localhost:3000. Health check: `GET /health`.

## Project Structure

```
packages/
  server/   — Fastify REST API + TypeORM (PostgreSQL)
  worker/   — Temporal worker (placeholder)
  sdk/      — @flowstile/sdk npm package (placeholder)
  ui/       — React frontend (placeholder)
```

## Commands

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start server with hot reload |
| `pnpm test` | Run unit tests (no DB needed) |
| `pnpm --filter @flowstile/server test:integration` | Run integration tests (requires Docker PostgreSQL) |
| `pnpm --filter @flowstile/server db:seed` | Seed sample data |
| `docker compose up -d` | Start PostgreSQL + Temporal Server |
| `docker compose down` | Stop all services |

## Architecture

See [Design Spec](docs/superpowers/specs/2026-04-23-flowstile-design.md).

## License

Apache 2.0
