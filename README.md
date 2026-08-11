# Webhook Delivery Platform

A backend service for reliably delivering event notifications to external
HTTP endpoints, with asynchronous processing, retries, idempotency, and HMAC
signing. See `docs/SPEC.md`, `docs/ARCHITECTURE.md`, and
`docs/IMPLEMENTATION_PLAN.md` for the full design.

This repository is currently at **Part 1 — Foundation and Runtime Skeleton**:
a running, typed, observable application shell with a live database
connection. No domain routes exist yet.

## Prerequisites

- Node.js 22 or later
- Docker and Docker Compose

## Setup

```bash
# 1. Start PostgreSQL
docker compose up -d

# 2. Configure environment
cp .env.example .env

# 3. Install dependencies
npm ci

# 4. Generate the Prisma client
npm run db:generate

# 5. Run the server
npm run dev
```

The server listens on `http://localhost:3000` by default (`PORT` in `.env`).

> If `docker compose up -d` succeeds but the app or `/health` cannot reach
> the database, check for another PostgreSQL instance already bound to port
> 5432 on your machine (e.g. a Homebrew service) — it will intercept the
> connection before it reaches the container. Stop the other instance or
> change the host port mapping in `docker-compose.yml` and `DATABASE_URL`.

- Health check: `GET http://localhost:3000/health`
- API documentation (Swagger UI): `http://localhost:3000/docs`
- Raw OpenAPI document: `http://localhost:3000/docs/json`

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Run the server with file watching |
| `npm start` | Run the server (no watching) |
| `npm run typecheck` | `tsc --noEmit`, the strict type-checking gate |
| `npm test` | Run the test suite (`node --test`) |
| `npm run db:generate` | Regenerate the Prisma client from `prisma/schema.prisma` |

## Testing

```bash
npm test
```

The test command loads `.env` if present, so `DATABASE_URL` and the rest of
the configuration are available the same way they are for `dev`/`start`. Part
1's tests are pure (configuration validation, error-handler shape) and do not
touch the database. Later parts add integration tests that do; to keep those
isolated from development data, create a separate test database once:

```bash
docker compose exec postgres createdb -U webhooks webhooks_test
```

and point `DATABASE_URL` in `.env` (or an environment override) at
`webhooks_test` when running the suite.

## Configuration

All configuration is read from environment variables by
`src/app/config.ts`, the only module allowed to read `process.env`. Missing
or invalid required values abort startup immediately with a message on
stderr and a non-zero exit code — there are no silent defaults for anything
security- or correctness-relevant. See `.env.example` for the full list.

## Project structure

```
src/
├── app/            server assembly, configuration, lifecycle, health route
├── infrastructure/ Prisma client, structured logging
└── shared/errors/  shared application error model and Fastify error handler
prisma/             schema.prisma (no models yet — see IMPLEMENTATION_PLAN.md)
test/               node:test suite
```

## Known limitations at this stage

No domain models, routes beyond `/health`, or background worker exist yet.
These are introduced in later implementation parts per
`docs/IMPLEMENTATION_PLAN.md`.
