# Webhook Delivery Platform

A backend service for reliably delivering event notifications to external
HTTP endpoints, with asynchronous processing, retries, idempotency, and HMAC
signing. See `docs/SPEC.md`, `docs/ARCHITECTURE.md`, and
`docs/IMPLEMENTATION_PLAN.md` for the full design.

This repository is currently at **Part 3 — Event Publication, Idempotency, and
Delivery Fan-out**: webhook endpoints and their subscriptions can be managed
through the API, and an event can be published, persisted together with its
full set of delivery records in one transaction, and protected against
duplicate creation under concurrent requests. The background worker that
actually sends the webhooks is not implemented yet, so deliveries stay in
`PENDING`.

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

# 5. Apply migrations
npm run db:migrate

# 6. Seed the fixed event type catalog
npm run db:seed

# 7. Run the server
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

## API surface (Parts 2–3)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/endpoints` | Register a webhook endpoint (generates the signing secret server-side) |
| `GET` | `/endpoints` | List webhook endpoints |
| `GET` | `/endpoints/:endpointId` | Fetch a webhook endpoint |
| `PATCH` | `/endpoints/:endpointId` | Update a webhook endpoint, including enabling/disabling it via `enabled` — there is no separate disable route |
| `DELETE` | `/endpoints/:endpointId` | Delete a webhook endpoint; its subscriptions and deliveries cascade-delete with it |
| `POST` | `/endpoints/:endpointId/subscriptions` | Subscribe an endpoint to an event type by name (e.g. `"order.created"`) |
| `GET` | `/endpoints/:endpointId/subscriptions` | List an endpoint's subscriptions |
| `DELETE` | `/endpoints/:endpointId/subscriptions/:subscriptionId` | Remove a subscription |
| `POST` | `/events` | Publish an event; supports the optional `Idempotency-Key` header |
| `GET` | `/events/:eventId` | Fetch a published event |
| `GET` | `/events/:eventId/deliveries` | List the deliveries created for an event |

No endpoint response ever includes the signing secret. The event type
catalog is fixed and seeded (`prisma/seed.ts`); it has no public CRUD route.
Outbound URLs are validated by `src/infrastructure/security/url-safety.ts`
(SSRF protection) at both creation and update.

### Publishing an event

```bash
curl -X POST http://localhost:3000/events \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000' \
  -d '{"type":"order.completed","payload":{"orderId":5821,"amount":1499}}'
```

Publication persists the event and, in the same transaction, one `PENDING`
delivery per **enabled** endpoint holding a subscription to that event type. A
disabled endpoint receives none, and an event with no matching subscription is
still accepted with zero deliveries. No outbound HTTP request happens during
publication; the response time does not depend on any receiver.

`Idempotency-Key` is optional and unique across events when present:

- replaying the same key with the same request returns the **original** event
  with `200` instead of creating a second event and a second delivery set;
- reusing the same key for a materially different request is an idempotency
  conflict and returns `409`.

Uniqueness is enforced by a unique index in PostgreSQL and the resulting
constraint violation is handled, so two genuinely concurrent requests with one
key still produce exactly one event.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Run the server with file watching |
| `npm start` | Run the server (no watching) |
| `npm run typecheck` | `tsc --noEmit`, the strict type-checking gate |
| `npm test` | Run the test suite (`node --test`) |
| `npm run db:generate` | Regenerate the Prisma client from `prisma/schema.prisma` |
| `npm run db:migrate` | Apply Prisma migrations (`prisma migrate dev`) |
| `npm run db:seed` | Seed the fixed event type catalog |

## Testing

```bash
npm test
```

The test command loads `.env` if present, so `DATABASE_URL` and the rest of
the configuration are available the same way they are for `dev`/`start`. It
also passes `--test-concurrency=1`: the integration tests share one database
and truncate it between tests, so running test *files* in parallel would let
them delete each other's fixtures. Tests within a file already run in
sequence, and genuine concurrency is created inside a test where it is the
thing being asserted.

The integration tests touch the database (endpoint/subscription CRUD, the
duplicate-subscription constraint under concurrent requests, secret absence
from every response, event publication, the idempotency race, transactional
fan-out). To keep those isolated from development data, create a separate test
database once:

```bash
docker compose exec postgres createdb -U webhooks webhooks_test
```

and point `DATABASE_URL` at it when running the suite (a shell-exported
`DATABASE_URL` overrides the value from `.env`):

```bash
DATABASE_URL="postgresql://webhooks:webhooks@localhost:5432/webhooks_test?schema=public" \
  node --env-file-if-exists=.env node_modules/.bin/prisma migrate deploy
DATABASE_URL="postgresql://webhooks:webhooks@localhost:5432/webhooks_test?schema=public" npm test
```

The URL safety unit tests (`test/url-safety.test.ts`) are pure and do not
touch the database.

## Configuration

All configuration is read from environment variables by
`src/app/config.ts`, the only module allowed to read `process.env`. Missing
or invalid required values abort startup immediately with a message on
stderr and a non-zero exit code — there are no silent defaults for anything
security- or correctness-relevant. See `.env.example` for the full list.

## Project structure

```
src/
├── app/                 server assembly, configuration, lifecycle, health route
├── modules/
│   ├── endpoints/       webhook endpoint CRUD (routes, schemas, service)
│   ├── subscriptions/   endpoint-to-event-type subscriptions
│   ├── events/          event publication, idempotency, delivery fan-out
│   └── deliveries/      delivery reads (the worker owns the write side)
├── infrastructure/
│   ├── database/        Prisma client
│   ├── logging/          structured logging
│   └── security/         centralized outbound URL safety (SSRF protection)
└── shared/errors/       shared application error model and Fastify error handler
prisma/                  schema.prisma, migrations/, seed.ts (event type catalog)
test/                    node:test suite (unit + integration)
```

## Known limitations at this stage

Delivery attempts, the background worker, HMAC signing, retries, manual
retry, delivery history filters, and metrics are not implemented yet:
deliveries are created and stay in `PENDING`, and no webhook is sent. The
URL safety module validates the literal host given in a URL; it does not
perform DNS resolution, so DNS rebinding between validation and a future
delivery attempt is a known, accepted risk for this project's scope (see
`src/infrastructure/security/url-safety.ts`). These are addressed in later
implementation parts per `docs/IMPLEMENTATION_PLAN.md`.
