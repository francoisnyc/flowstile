# Self-Hosting Flowstile

How to run Flowstile for a single organization in production. Flowstile is a
single-tenant, self-hosted, bring-your-own-Temporal system — one deployment
serves one organization.

## Topology

Five processes, plus two infrastructure dependencies you operate:

| Component | What it is | Scale |
|---|---|---|
| **server** (`packages/server`) | Fastify REST API + the inbox's backend (auth, RBAC, tasks, forms, signal delivery). Stateless. | 1+ replicas behind a load balancer |
| **worker** (`packages/worker`, or your own) | Temporal worker hosting your workflow definitions. | 1+ replicas |
| **ui** (`packages/ui`) | Static React app (inbox + form designer). | served as static files / CDN |
| **PostgreSQL** | System of record for users, tasks, forms, cases. | your managed Postgres |
| **Temporal** | Durable workflow execution (self-hosted or Temporal Cloud). | your Temporal |

The server is the only component that talks to Postgres. Both the server and the
worker talk to Temporal. The worker talks to the server's REST API with a service
API key. There is **no multi-tenancy** — isolate per-org by running separate
deployments.

## 1. Prerequisites

- Node 22+, `pnpm` (via `corepack enable`)
- PostgreSQL 14+
- A Temporal cluster (self-hosted `temporal server` or Temporal Cloud) reachable
  at `TEMPORAL_ADDRESS`
- Object storage (S3 or compatible) if you want durable attachments at scale

Dockerfiles are provided for `packages/{server,worker,ui}`; `docker-compose.yml`
brings up Postgres + Temporal for local/dev.

## 2. Configuration

All configuration is environment variables — see [`.env.example`](../.env.example)
for the complete annotated list. The load-bearing ones:

- `NODE_ENV=production` — turns **off** schema sync (migrations run on boot
  instead), marks auth cookies `Secure` (so you **must** serve over HTTPS), and
  disables dev fallbacks.
- `JWT_SECRET` — **required**; the server refuses to boot without it. Generate a
  strong value: `openssl rand -hex 32`.
- `DATABASE_*` — your Postgres connection.
- `TEMPORAL_ADDRESS` — your Temporal cluster.
- `CORS_ORIGINS` — only if the UI is served from a different origin than the API.

## 3. Database and migrations

The schema is managed by TypeORM migrations (committed under
`packages/server/src/migrations`).

- **In production (`NODE_ENV=production`) the server applies pending migrations
  automatically on boot.** Nothing extra to run for a normal deploy.
- To apply them explicitly (e.g. a dedicated migration step before rolling
  servers), build and run: `pnpm --filter @flowstile/server db:migrate`.
- **Do not run `pnpm db:seed` in production** — it TRUNCATES all tables and loads
  demo users/processes. It is dev-only.
- After changing entities, generate a new migration with
  `pnpm --filter @flowstile/server db:generate src/migrations/<Name>` (against a
  database at the current migrated state) and commit it.

## 4. First run: bootstrap an admin

A fresh production database has no users. Create the built-in roles and your first
admin **without** the dev seed:

```bash
pnpm --filter @flowstile/server build
NODE_ENV=production \
ADMIN_EMAIL=admin@your-org.com \
ADMIN_PASSWORD='<a strong password>' \
  pnpm --filter @flowstile/server db:bootstrap
```

This is idempotent and adds no demo data — it ensures the `admin` and `task-user`
roles exist and creates the admin user (skipping it if the email already exists).

### Create a worker service key

Log in as the admin and mint a service API key for the worker (the only response
that ever contains the plaintext token):

```bash
# obtain an admin cookie/token from POST /auth/login, then:
curl -sX POST https://api.your-org.com/auth/api-keys \
  -H "Authorization: Bearer <admin token>" -H 'Content-Type: application/json' \
  -d '{"name":"prod-worker","permissions":["tasks:read","tasks:write","processes:start"]}'
# → { ..., "token": "fsk_..." }   ← set this as the worker's FLOWSTILE_API_KEY
```

## 5. Run the services

After `pnpm build` (or using the Dockerfiles):

```bash
# Server (applies migrations on boot; needs JWT_SECRET + DATABASE_* + TEMPORAL_ADDRESS)
NODE_ENV=production pnpm --filter @flowstile/server start

# Worker (needs FLOWSTILE_API_KEY + FLOWSTILE_SERVER_URL + TEMPORAL_ADDRESS;
# fails fast in production if FLOWSTILE_API_KEY is unset)
NODE_ENV=production pnpm --filter @flowstile/worker start

# UI: build static assets and serve them (behind the same TLS as the API)
pnpm --filter @flowstile/ui build   # → packages/ui/dist
```

A Python worker (see `sdk-python/`) is a drop-in alternative to `packages/worker`
— it authenticates with the same service API key and the same `TEMPORAL_ADDRESS`.

`GET /health` returns `{ "status": "ok", "database": "connected" }` for liveness.

## 6. Production checklist

- [ ] `NODE_ENV=production` everywhere, and the API + UI served over **HTTPS**
      (cookies are `Secure`; auth breaks over plain HTTP).
- [ ] `JWT_SECRET` set to a strong random value, stored in your secrets manager.
- [ ] Real `DATABASE_PASSWORD` (not the `flowstile` dev default).
- [ ] Worker authenticates with a real `FLOWSTILE_API_KEY` (minted in step 4), not
      the dev key.
- [ ] Did **not** run `db:seed`; admin created via `db:bootstrap`.
- [ ] `CORS_ORIGINS` set if the UI is cross-origin; otherwise same-origin only.
- [ ] Attachments: `ATTACHMENT_STORE=s3` with bucket/region for durability
      (local disk does not survive replica loss).
- [ ] Postgres backups configured (the system of record).
- [ ] Temporal retention/namespace configured for your workflows.

## 7. Upgrades

1. Pull the new release and `pnpm build`.
2. Roll the server — pending migrations apply on boot (or run `db:migrate` as a
   pre-deploy step). Migrations are forward-only; review any new ones first.
3. Roll workers. Long-running workflows replay against the new code, so treat
   workflow-shape changes as versioned (see the `temporal-developer` skill's
   versioning references).

## 8. Observability

- **Logs** — structured (pino) JSON on stdout. **Liveness** — `GET /health`.
- **Server metrics** — Prometheus at `GET /metrics` (unauthenticated like
  `/health`; restrict at the network layer). Exposes HTTP RED (request rate,
  latency histogram, errors by route/status), Node defaults, and domain gauges:
  - `flowstile_signal_outbox_messages{status}` and
    `flowstile_signal_outbox_oldest_pending_age_seconds` — **the most important
    signals**: a rising pending count / oldest age or `failed > 0` means signal
    delivery is stuck and workflows may be hung. Alert on these.
  - `flowstile_open_tasks{status}` and `flowstile_oldest_open_task_age_seconds`
    — the inbox backlog and human-SLA signal.
- **Worker metrics** — set `WORKER_METRICS_PORT` to expose the Temporal SDK's own
  metrics (workflow/activity latency, task-slot usage, poller counts, failures)
  in Prometheus format at `0.0.0.0:<port>/metrics`.
- **Workflow execution** — the Temporal UI / Temporal Cloud for per-workflow
  history and failures.

Not yet shipped: distributed **tracing** (OpenTelemetry across the human-task
boundary) and prebuilt alert rules.

## Known gaps

- **Single-tenant** by design — run separate deployments per organization.
