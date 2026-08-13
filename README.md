# Webhook Delivery Platform

A backend service for reliably delivering event notifications to external
HTTP endpoints: asynchronous processing, bounded exponential-backoff
retries, crash recovery, idempotent publication, and HMAC-SHA256 signed
outbound requests.

The system is functionally complete: endpoints and subscriptions can be
managed, events are published durably and fanned out to matching
subscribers, a background worker delivers them asynchronously with retries
and lease-based crash recovery, failed deliveries can be manually retried,
delivery history and basic metrics are queryable, and the whole flow is
demonstrable locally with nothing beyond Docker Compose and Node.js.

## Architecture at a glance

A single Node.js/Fastify process serves the REST API and runs the
background delivery worker together (a modular monolith, not
microservices). PostgreSQL is the only durable store and the only
coordination mechanism between them:

```text
API request → validate → persist Event + PENDING Deliveries (one transaction) → respond
                                          │
                                          ▼ (never called directly by the API)
                                   PostgreSQL (source of truth)
                                          │
                                          ▼
                            Delivery Worker (same process)
                     claim (SKIP LOCKED) → sign → POST → record attempt → transition state
```

Publishing an event never performs an outbound HTTP request; the worker is
the only thing that does. This keeps API response latency independent of
receiver behavior and is enforced by keeping delivery execution unreachable
from route/service code, not just by convention.

**Tech stack:** Node.js (22+) with TypeScript in strict mode, Fastify,
Prisma, PostgreSQL, Docker Compose for local infrastructure, and
OpenAPI/Swagger for API documentation. No Redis, Kafka, queue broker, or
other distributed infrastructure — retry scheduling, delivery claiming, and
crash recovery are all PostgreSQL-backed (see "Asynchronous delivery" below).

## Prerequisites

- Node.js 22 or later
- Docker and Docker Compose

## Setup (clean machine)

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

> The container publishes PostgreSQL on host port **5433**, not 5432, so it
> does not collide with a PostgreSQL server already running on the host (a
> Homebrew service, say) — such a server binds `127.0.0.1:5432` specifically
> and would silently intercept connections meant for the container. If the
> app or `/health` still cannot reach the database, check that nothing else
> holds 5433 and that `DATABASE_URL` names that port.

- Health check: `GET http://localhost:3000/health`
- API documentation (Swagger UI): `http://localhost:3000/docs`
- Raw OpenAPI document: `http://localhost:3000/docs/json`

## Configuration

All configuration is read from environment variables by `src/app/config.ts`,
the only module allowed to read `process.env` in the application itself.
Missing or invalid required values abort startup immediately with a message
on stderr and a non-zero exit code — there are no silent defaults for
anything security- or correctness-relevant. See `.env.example` for the full,
documented list, including the worker's poll interval, concurrency, batch
size, delivery timeout, retry backoff, and shutdown grace period.

Two configuration values matter most for local demonstration:

- `ALLOW_LOCAL_ENDPOINTS` — off by default, and structurally impossible to
  enable under `NODE_ENV=production` (startup itself fails if both are set,
  and the URL safety module independently refuses to honor the flag under
  production configuration regardless — see "Endpoint safety / SSRF
  protections" below). Set it to `true` in development so a webhook endpoint
  can point at `127.0.0.1`, which is otherwise rejected as an SSRF risk.
- `DELIVERY_TIMEOUT_MS` — the hard timeout on one outbound webhook request.

## API surface

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/endpoints` | Register a webhook endpoint (generates the signing secret server-side; never returned) |
| `GET` | `/endpoints` | List webhook endpoints |
| `GET` | `/endpoints/:endpointId` | Fetch a webhook endpoint |
| `PATCH` | `/endpoints/:endpointId` | Update a webhook endpoint, including enabling/disabling it via `enabled` — there is no separate disable route |
| `DELETE` | `/endpoints/:endpointId` | Delete a webhook endpoint; its subscriptions cascade-delete with it |
| `POST` | `/endpoints/:endpointId/subscriptions` | Subscribe an endpoint to an event type by name (e.g. `"order.created"`) |
| `GET` | `/endpoints/:endpointId/subscriptions` | List an endpoint's subscriptions |
| `DELETE` | `/endpoints/:endpointId/subscriptions/:subscriptionId` | Remove a subscription |
| `POST` | `/events` | Publish an event; supports the optional `Idempotency-Key` header |
| `GET` | `/events/:eventId` | Fetch a published event |
| `GET` | `/events/:eventId/deliveries` | List the deliveries created for an event |
| `GET` | `/deliveries` | List deliveries, filterable by `status`, `endpointId`, `eventId`; bounded `limit`/`offset` pagination |
| `GET` | `/deliveries/:deliveryId` | Fetch a single delivery |
| `GET` | `/deliveries/:deliveryId/attempts` | List a delivery's full attempt history, oldest first |
| `POST` | `/deliveries/:deliveryId/retry` | Manually retry a `FAILED` delivery; `409` from any other state, `404` for an unknown id |
| `GET` | `/metrics` | Basic operational metrics computed from persisted rows |
| `GET` | `/health` | Liveness/readiness, including database reachability |

No endpoint response ever includes the signing secret — every response
schema simply has no property for it (`fast-json-stringify` cannot emit a
field it was not told about), and it is confirmed by integration tests. The
event type catalog is fixed and seeded (`prisma/seed.ts`); it has no public
CRUD route. Outbound URLs are validated by
`src/infrastructure/security/url-safety.ts` (SSRF protection) at both
creation and update, and again immediately before every delivery attempt.

Every non-2xx response uses one shared shape:

```json
{ "error": { "code": "NOT_FOUND", "message": "…", "requestId": "…", "details": {} } }
```

`details` is present only for some error categories (e.g. AJV schema
validation failures) and is never a stack trace or a Prisma internal.
Swagger documents this shape for every status code a given route can
actually return.

### Publishing an event

```bash
curl -X POST http://localhost:3000/events \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000' \
  -d '{"type":"order.completed","payload":{"orderId":5821,"amount":1499}}'
```

Publication persists the event and, in the same transaction, one `PENDING`
delivery per **enabled** endpoint holding a subscription to that event type.
A disabled endpoint receives none, and an event with no matching
subscription is still accepted with zero deliveries. No outbound HTTP
request happens during publication; the response time does not depend on
any receiver — delivery is asynchronous, performed by the background worker.

`Idempotency-Key` is optional and unique across events when present:

- replaying the same key with the same request returns the **original**
  event with `200` instead of creating a second event and delivery set;
- reusing the same key for a materially different request is an idempotency
  conflict and returns `409`.

Uniqueness is enforced by a unique index in PostgreSQL and the resulting
constraint violation is handled, so two genuinely concurrent requests with
one key still produce exactly one event — not merely "usually one" under a
read-then-write race.

## Asynchronous delivery, retries, and recovery

The worker polls PostgreSQL for eligible deliveries (`PENDING`, or
`RETRY_SCHEDULED` whose `nextAttemptAt` is due), claims a bounded batch
atomically with a `FOR UPDATE SKIP LOCKED` query so two workers never claim
the same row, and runs the batch through a bounded concurrency pool
(`WORKER_CONCURRENCY`). Nothing about scheduled work lives only in process
memory: `nextAttemptAt` and the claim/lease columns are all persisted
columns, not `setTimeout` calls, so a restart loses no pending or scheduled
work.

A claimed delivery gets a **processing lease** (`claimedAt`/`leaseUntil`,
derived from `DELIVERY_TIMEOUT_MS` and always longer than it — see the
derivation comment in `src/app/config.ts`). If the process crashes or is
killed mid-delivery, the lease eventually expires and a recovery sweep
returns the delivery to a processable state without losing any
`DeliveryAttempt` history, so nothing stays stuck in `PROCESSING` forever.

Retry policy is bounded exponential backoff, computed by a pure function
(`src/worker/retry-policy.ts`) from `MAX_DELIVERY_ATTEMPTS`,
`RETRY_BASE_DELAY_MS`, and `RETRY_MAX_DELAY_MS` — never a literal embedded in
business logic. HTTP response classification:

- `2xx` → success, delivery `DELIVERED`;
- `408`, `429`, any `5xx`, a timeout, or a connection failure → retryable,
  `RETRY_SCHEDULED` until the attempt budget is exhausted, then `FAILED`;
- every other `4xx`, and any `3xx` (redirects are never followed — see SSRF
  notes below) → permanent failure, straight to `FAILED` without consuming
  retry budget.

Manual retry (`POST /deliveries/:deliveryId/retry`) is legal only from
`FAILED`. It returns the delivery to `PENDING`, resets the automatic-attempt
budget so it is not immediately re-exhausted, and preserves every prior
`DeliveryAttempt` — attempt numbering continues rather than restarting.
Retrying from any other state returns `409` and changes nothing; an unknown
delivery id returns `404`.

Delivery is **at-least-once**, not exactly-once — a worker crash after a receiver
accepted a request but before the platform recorded the outcome can result
in the same webhook being sent again. Receivers should deduplicate on
`deliveryId`, which is included in every delivery's payload envelope.

## Webhook signing and receiver-side verification

Each outbound request is a `POST` with a JSON body and two signing headers,
generated by `src/infrastructure/security/signing.ts`, the single place in
the codebase that computes a signature:

```text
X-Webhook-Timestamp: <unix time in whole seconds>
X-Webhook-Signature: sha256=<lowercase hex HMAC-SHA256>
```

```text
signature = HMAC-SHA256(key = endpoint signing secret, message = "<timestamp>." + <raw body bytes>)
```

The payload is serialized exactly once; that same byte array is both the
HMAC input and the request body sent over the wire, so there is no
opportunity for a re-serialization to produce bytes that do not match what
was signed. The body is:

```json
{ "deliveryId": "…", "eventId": "…", "type": "order.completed",
  "createdAt": "…", "payload": { } }
```

A receiver should verify the signature against the **raw** body, before
parsing it as JSON, using a constant-time comparison, and should reject a
request whose timestamp falls outside a tolerance window it considers
acceptable (basic replay protection). Redirects are
never followed by the outbound client, so a receiver never needs to worry
about a signed request being redirected to an unintended destination.

`scripts/verify-signature.ts` is the reference implementation of that
verification — a small, pure `verifyWebhookSignature()` function using
`crypto.timingSafeEqual` for the comparison and a configurable timestamp
tolerance (5 minutes by default). `scripts/demo-receiver.ts` (see "Running
the local demo" below) uses it on every request it receives and logs the
result (`valid` / `invalid (<reason>)`) to stdout — never the secret itself.
`test/verify-signature.test.ts` exercises it against a real signature
produced by the platform's own signing code, including a tampered payload,
a tampered signature, a wrong secret, and a stale timestamp.

## Endpoint safety / SSRF protections

Because the platform makes outbound requests to user-supplied URLs,
`src/infrastructure/security/url-safety.ts` is the single, centralized
decision point for whether a destination is safe — called at endpoint
creation, at endpoint update, and again immediately before every delivery
attempt (an endpoint can be repointed or disabled in the unbounded time
between publication and delivery). It rejects:

- schemes other than `http`/`https` (`https` is required under
  `NODE_ENV=production`);
- `localhost` and its variants, loopback addresses (`127.0.0.0/8`, `::1`),
  the unspecified address, and embedded credentials;
- private and link-local ranges (RFC 1918, RFC 6598 carrier-grade NAT,
  IPv6 unique-local/`fe80::/10`), including numeric-encoding tricks
  (decimal/hex/octal IPv4 literals) and IPv4-mapped/NAT64 IPv6 addresses
  that embed one of the above;
- known cloud metadata addresses (`169.254.169.254` and Oracle Cloud's
  `192.0.0.192`);
- malformed hosts.

`ALLOW_LOCAL_ENDPOINTS` (off by default) is the one explicit,
development-only exemption, and it only ever exempts loopback/localhost —
never a private or link-local range. It cannot take effect in production:
setting it alongside `NODE_ENV=production` fails startup outright, and the
URL safety module independently refuses to honor it whenever
`nodeEnv === "production"`, so a single weakened guard elsewhere could not
silently open this up.

**Known, accepted limitation:** this module validates the literal host
given in the URL. It does not perform DNS resolution, so a hostname that
resolves to a public address at validation time but is later repointed at
an internal address (DNS rebinding) is not caught. This is an explicitly
accepted risk for this project's scope, documented rather than silently
ignored.

## Basic metrics

`GET /metrics` reports, computed live from PostgreSQL aggregate queries (no
separate metrics infrastructure): total events accepted, total deliveries
created, delivered, failed, pending-or-retrying, success rate, and average
delivery duration in milliseconds.

## Project structure

```
src/
├── app/                 server assembly, configuration, lifecycle, health route
├── modules/
│   ├── endpoints/        webhook endpoint CRUD (routes, schemas, service)
│   ├── subscriptions/     endpoint-to-event-type subscriptions
│   ├── events/            event publication, idempotency, delivery fan-out
│   ├── deliveries/        delivery/attempt reads, filtering, state transitions, manual retry
│   └── metrics/           basic operational metrics
├── worker/               delivery loop, atomic claiming, retry policy, lease recovery, per-delivery execution
├── infrastructure/
│   ├── database/          Prisma client
│   ├── http/               outbound webhook client (timeout, no hidden retries)
│   ├── logging/             structured logging
│   └── security/            outbound URL safety (SSRF) and HMAC-SHA256 signing
└── shared/errors/        shared application error model, Fastify error handler, OpenAPI error schema
prisma/                   schema.prisma, migrations/, seed.ts (event type catalog)
scripts/                  demo-only: local test receiver and its signature-verification module
test/                     node:test suite (unit + integration)
```

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
thing being asserted (e.g. the idempotency race, parallel delivery claims).

The integration tests touch the database extensively — endpoint/subscription
CRUD, the duplicate-subscription constraint under concurrency, secret
absence from every response shape, event publication and the idempotency
race, transactional fan-out, worker claiming and concurrency limits, the
full retry/backoff/recovery lifecycle, manual retry, delivery history
filters, and metrics. To keep those isolated from development data, create a
separate test database once:

```bash
docker compose exec postgres createdb -U webhooks webhooks_test
```

and point `DATABASE_URL` at it when running the suite (a shell-exported
`DATABASE_URL` overrides the value from `.env`):

```bash
DATABASE_URL="postgresql://webhooks:webhooks@localhost:5433/webhooks_test?schema=public" \
  node --env-file-if-exists=.env node_modules/.bin/prisma migrate deploy
DATABASE_URL="postgresql://webhooks:webhooks@localhost:5433/webhooks_test?schema=public" npm test
```

Pure unit tests (URL safety, retry-policy arithmetic, HMAC signing,
signature verification, config validation, the error handler) do not touch
the database and pass under either `DATABASE_URL`.

## Running the local demo

This walks through every core scenario the platform supports — register,
subscribe, publish, successful delivery, simulated failure with retries,
eventual success or permanent failure, manual retry, history inspection,
signature verification, and duplicate-request protection — using
`scripts/demo-receiver.ts` as the receiver. All commands below assume the
setup steps above have already been run.

1. **Start PostgreSQL and the application**, with the development SSRF
   exemption enabled so a `127.0.0.1` endpoint is accepted, and a short
   delivery timeout/retry backoff so the demo does not require long waits:

   ```bash
   docker compose up -d
   ALLOW_LOCAL_ENDPOINTS=true DELIVERY_TIMEOUT_MS=2000 WORKER_POLL_INTERVAL_MS=300 \
     MAX_DELIVERY_ATTEMPTS=3 RETRY_BASE_DELAY_MS=500 RETRY_MAX_DELAY_MS=2000 \
     npm run dev
   ```

2. **Start demo receivers**, one per scenario, each on its own port. A
   receiver's signing secret is not yet known at this point — endpoint
   creation generates it, and it can be picked up in step 3.

   ```bash
   # Always succeeds
   node scripts/demo-receiver.ts --port=4000 --mode=success --secret=placeholder

   # Fails the first 2 requests, then succeeds — demonstrates retry-then-success
   node scripts/demo-receiver.ts --port=4001 --mode=success --fail-times=2 --secret=placeholder

   # Always fails with 500 — demonstrates exhausting the retry budget
   node scripts/demo-receiver.ts --port=4002 --mode=fail --secret=placeholder

   # Never responds in time — demonstrates a delivery timeout
   node scripts/demo-receiver.ts --port=4003 --mode=timeout --secret=placeholder --delivery-timeout-ms=2000
   ```

   (`--secret` only affects the logged verification result, not the
   response status, so the demo works even before it is corrected — see
   step 7 to make signature verification actually pass.)

3. **Create webhook endpoints**, one per receiver, and **subscribe** each to
   `order.completed`:

   ```bash
   curl -X POST http://localhost:3000/endpoints -H 'Content-Type: application/json' \
     -d '{"name":"success","url":"http://127.0.0.1:4000/hook"}'
   # repeat for the retry (4001), fail (4002), and timeout (4003) receivers,
   # and again for a "connection-refused" endpoint pointed at a port nothing
   # is listening on, e.g. http://127.0.0.1:4009/hook — no receiver needed
   # for that one.

   curl -X POST http://localhost:3000/endpoints/<endpointId>/subscriptions \
     -H 'Content-Type: application/json' -d '{"eventType":"order.completed"}'
   ```

4. **Publish an event**, with an `Idempotency-Key`:

   ```bash
   curl -X POST http://localhost:3000/events \
     -H 'Content-Type: application/json' \
     -H 'Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000' \
     -d '{"type":"order.completed","payload":{"orderId":5821,"amount":1499}}'
   ```

   The response returns immediately (`201`) with the event id — publication
   never waits on any receiver.

5. **Duplicate-request protection**: replay the exact same request (same
   `Idempotency-Key`, same body) and confirm it returns `200` with the same
   event id instead of creating a second event; then replay the same key
   with a different body and confirm `409`.

6. **Observe asynchronous delivery**: poll
   `GET /events/<eventId>/deliveries`. Within a few worker polls:
   - the endpoint on 4000 reaches `DELIVERED` after one attempt;
   - the endpoint on 4001 reaches `DELIVERED` after three attempts (two
     `RETRY_SCHEDULED` failures, then success);
   - the endpoint on 4002 reaches `FAILED` after exhausting
     `MAX_DELIVERY_ATTEMPTS` attempts, all `RETRYABLE_FAILURE` / HTTP 500;
   - the endpoint on 4003 reaches `FAILED` the same way, each attempt
     categorized `TIMEOUT`;
   - the connection-refused endpoint reaches `FAILED` the same way, each
     attempt categorized `CONNECTION_ERROR` (`ECONNREFUSED`).

   Inspect each one's history with
   `GET /deliveries/<deliveryId>` and `GET /deliveries/<deliveryId>/attempts`
   — attempt number, outcome, HTTP status where available, duration, and
   error category are all present.

7. **Signature verification**: each demo receiver's stdout logs one line per
   request with the verification result. With the placeholder secrets from
   step 2 it correctly reports `invalid (signature mismatch)` — the
   endpoint's real signing secret is generated server-side and never
   returned by the API. To see a `valid` result, read it directly from the
   database (this is the operator's own database, not something a real
   external receiver could do) and restart the corresponding receiver with
   it:

   ```bash
   docker compose exec postgres psql -U webhooks -d webhooks -t -A \
     -c "SELECT \"signingSecret\" FROM \"WebhookEndpoint\" WHERE id = '<endpointId>';"

   node scripts/demo-receiver.ts --port=4000 --mode=success --secret=<the secret above>
   ```

   Publishing another event to that endpoint's subscription now logs
   `"signature":"valid"`.

8. **Manual retry**: pick the `FAILED` delivery from step 6 (e.g. the 4002
   endpoint) and retry it:

   ```bash
   curl -X POST http://localhost:3000/deliveries/<deliveryId>/retry
   ```

   The response is `200` with `state: "PENDING"`. Because the receiver is
   still failing, the worker re-exhausts the (reset) budget and the delivery
   reaches `FAILED` again — `GET /deliveries/<deliveryId>/attempts` shows
   attempt numbering continuing (e.g. 4, 5, 6) rather than restarting at 1,
   and every prior attempt is still present. Retrying a delivery that is not
   `FAILED` (e.g. the already-`DELIVERED` one from 4000) returns `409`;
   retrying an unknown id returns `404`.

9. **Metrics**: `GET /metrics` reflects the fixture built above — events
   accepted, deliveries by outcome, success rate, and average duration.

10. **Swagger**: open `http://localhost:3000/docs` to browse every route,
    request/response schema, the shared error shape, and the idempotency and
    signing behavior described above, generated from the same route
    definitions the server runs.

Every step above was run against the real application and a real
PostgreSQL database while writing this section, not merely written down and
assumed to work.

## Known limitations

- **DNS rebinding.** See "Endpoint safety / SSRF protections" above — the
  URL safety module validates the literal host, not a resolved address, and
  does not re-resolve DNS between validation and delivery.
- **At-least-once delivery, not exactly-once.** A crash between a receiver
  accepting a request and the platform recording the outcome can result in
  a duplicate delivery. Receivers should deduplicate on `deliveryId`.
- **Single-process worker.** The API and the delivery worker run in one
  Node.js process by design — there is no multi-instance worker coordination
  beyond the database-backed claim/lease mechanism, which does generalize to
  multiple worker processes if that were ever needed, but only one is run
  here.
- **HTTP response classification.** `2xx` succeeds; `408`/`429`/any
  `5xx`/timeouts/connection failures are retryable; every other `4xx` and
  any `3xx` (redirects are never followed, for SSRF reasons) is a permanent
  failure that does not consume retry budget. This is a project-level
  implementation choice rather than a fixed protocol requirement, documented
  here so it is not mistaken for one.
- **`scripts/demo-receiver.ts` and `scripts/verify-signature.ts` are demo
  scaffolding**, not a hardened reference receiver implementation — they
  exist to make the behaviors above observable locally, and intentionally
  stay small rather than growing into a testing framework.
