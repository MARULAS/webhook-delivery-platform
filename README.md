<div align="center">

# 📬 Webhook Delivery Platform

**A reliable backend service for asynchronously delivering application events to subscribed HTTP endpoints.**

[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Fastify](https://img.shields.io/badge/Fastify-REST%20API-000000?logo=fastify&logoColor=white)](https://fastify.dev)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org)
[![Prisma](https://img.shields.io/badge/Prisma-ORM-2D3748?logo=prisma&logoColor=white)](https://www.prisma.io)
[![Tests](https://img.shields.io/badge/tests-135%2F135%20passing-brightgreen)]()
[![Status](https://img.shields.io/badge/status-completed-success)]()

</div>

---

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
- [Delivery Lifecycle](#delivery-lifecycle)
- [Reliability & Retry Behavior](#reliability--retry-behavior)
- [Crash Recovery](#crash-recovery)
- [Idempotent Event Publication](#idempotent-event-publication)
- [Webhook Signing](#webhook-signing)
- [SSRF Protection](#ssrf-protection)
- [API Reference](#api-reference)
- [Metrics](#metrics)
- [Getting Started](#getting-started)
- [Configuration](#configuration)
- [Testing](#testing)
- [Local End-to-End Demo](#local-end-to-end-demo)
- [Project Structure](#project-structure)
- [Known Limitations](#known-limitations)
- [Project Status](#project-status)
- [Author](#author)

---

## Overview

The platform acts as a reliable intermediary between applications that **produce** events and external systems that want to **receive** them.

It persists events before processing, delivers webhooks through a PostgreSQL-backed background worker, retries transient failures with bounded exponential backoff, recovers interrupted work through processing leases, prevents duplicate publication with idempotency keys, and signs every outbound request using HMAC-SHA256.

### What happens when you publish an event

When an application publishes an `order.completed` event, the platform:

| # | Step |
|---|------|
| 1 | Persists the event in PostgreSQL |
| 2 | Finds webhook endpoints subscribed to `order.completed` |
| 3 | Creates a delivery record for each matching endpoint |
| 4 | **Returns immediately** to the event producer |
| 5 | Processes the deliveries asynchronously in the background |
| 6 | Signs each outbound request with HMAC-SHA256 |
| 7 | Records every delivery attempt |
| 8 | Retries temporary failures automatically |
| 9 | Marks exhausted or permanent failures as `FAILED` |
| 10 | Allows failed deliveries to be retried manually |

> [!NOTE]
> The producer never has to wait for — or directly depend on — external systems.

```mermaid
flowchart LR
    App[Producer Application] -->|POST /events| API[REST API]
    API --> DB[(PostgreSQL)]
    DB --> W[Delivery Worker]
    W -->|signed HTTP| E1[Webhook Endpoint A]
    W -->|signed HTTP| E2[Webhook Endpoint B]
    W -->|signed HTTP| E3[Webhook Endpoint C]
    W -.->|persist attempt| DB
```

---

## Features

<table>
<tr><td valign="top" width="50%">

**Core**
- Webhook endpoint management
- Event-type subscriptions
- Durable event publication
- Transactional delivery fan-out
- Idempotent event creation
- Delivery filtering and pagination
- Operational metrics

</td><td valign="top" width="50%">

**Worker & Reliability**
- PostgreSQL-backed asynchronous worker
- Atomic claiming with `FOR UPDATE SKIP LOCKED`
- Bounded worker concurrency
- Bounded exponential-backoff retries
- Durable retry scheduling
- Processing leases and crash recovery
- Manual retry for failed deliveries

</td></tr>
<tr><td valign="top">

**Security**
- HMAC-SHA256 request signing
- SSRF protections for outbound URLs
- HTTPS enforced in production

</td><td valign="top">

**Observability & DX**
- Delivery attempt history
- HTTP timeout handling
- Retryable / permanent failure classification
- OpenAPI / Swagger documentation
- Local end-to-end webhook receiver

</td></tr>
</table>

---

## Tech Stack

| Technology | Purpose |
|------------|---------|
| **Node.js 22+** | Application runtime |
| **TypeScript** | Strictly typed implementation |
| **Fastify** | REST API and server |
| **PostgreSQL 16** | Durable persistence and worker coordination |
| **Prisma** | Database access and migrations |
| **Docker Compose** | Local PostgreSQL infrastructure |
| **OpenAPI / Swagger** | Interactive API documentation |
| **node:test** | Unit and integration testing |

> [!IMPORTANT]
> The application intentionally requires **no Redis, Kafka, RabbitMQ, or any other message broker.** Pending work, retry schedules, processing leases, and delivery attempts are all persisted directly in PostgreSQL.

---

## Architecture

The project is implemented as a **modular monolith**. A single Node.js process contains two logical responsibilities — the REST API and the background delivery worker — with PostgreSQL as the durable source of truth shared by both.

```mermaid
flowchart TD
    A[POST /events] --> B[Validate request]
    B --> C["Persist Event + Deliveries<br/>(single transaction)"]
    C --> D[Return HTTP response]
    C --> DB[(PostgreSQL)]
    DB --> W[Background Worker]
    W --> CL[Atomic batch claim]
    CL --> SG[Sign HTTP request]
    SG --> EP[External endpoint]
    EP --> PR[Persist attempt / result]
    PR --> DB
```

> [!NOTE]
> Publishing an event **never** sends the webhook directly. Outbound HTTP communication belongs exclusively to the background worker, which keeps API response time independent of receiver behavior.

---

## Delivery Lifecycle

```mermaid
stateDiagram-v2
    [*] --> PENDING
    PENDING --> PROCESSING : claimed by worker
    PROCESSING --> DELIVERED : 2xx response
    PROCESSING --> RETRY_SCHEDULED : retryable failure
    RETRY_SCHEDULED --> PROCESSING : nextAttemptAt is due
    PROCESSING --> FAILED : permanent failure / budget exhausted
    FAILED --> PENDING : manual retry
    DELIVERED --> [*]
```

Every real outbound request creates a persistent `DeliveryAttempt` record. **Attempt history is preserved even when a delivery is manually retried.**

---

## Reliability & Retry Behavior

The worker atomically claims eligible deliveries from PostgreSQL using `FOR UPDATE SKIP LOCKED`. This prevents multiple workers from claiming the same row at the same time, while avoiding unnecessary blocking between them.

**Eligible deliveries are:**
- `PENDING`
- `RETRY_SCHEDULED` whose `nextAttemptAt` is due

**Retryable failures use bounded exponential backoff:**

```
delay = min(baseDelay × 2^(attempts - 1), maximumDelay)
```

Retry timing is stored in PostgreSQL rather than represented by long-lived in-memory timers — so **scheduled retries survive application restarts.**

### HTTP Result Classification

| Result | Behavior |
|--------|----------|
| `2xx` | ✅ `DELIVERED` |
| `408` Request Timeout | 🔁 Retryable |
| `429` Too Many Requests | 🔁 Retryable |
| `5xx` | 🔁 Retryable |
| Timeout | 🔁 Retryable |
| Connection failure | 🔁 Retryable |
| Other `4xx` | ❌ Permanent failure |
| `3xx` | ❌ Permanent failure — redirects are not followed |

When the configured retry budget is exhausted, the delivery becomes `FAILED`.

---

## Crash Recovery

Every claimed delivery receives a **processing lease** containing `claimedAt` and `leaseUntil`.

If the worker terminates mid-processing, the lease eventually expires. A recovery sweep detects expired `PROCESSING` deliveries and returns them to a processable state — preventing deliveries from becoming permanently stuck after a crash.

> [!WARNING]
> The platform provides **at-least-once** delivery, not exactly-once.
>
> A process can theoretically crash after the receiver accepts the request but before the platform records the result. In that case, the request may later be sent again.
>
> **Webhook receivers should deduplicate using the `deliveryId` contained in the webhook body.**

---

## Idempotent Event Publication

`POST /events` supports the optional `Idempotency-Key` header.

```bash
curl -X POST http://localhost:3000/events \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000' \
  -d '{
    "type": "order.completed",
    "payload": {
      "orderId": 5821,
      "amount": 1499
    }
  }'
```

| Scenario | Result |
|----------|--------|
| Same key + same request | `200` — the original event is returned |
| Same key + different request | `409 Conflict` |
| New request | `201` — event is created |

Uniqueness is enforced by PostgreSQL, so concurrent requests using the same key cannot create duplicate events.

---

## Webhook Signing

Every outbound webhook is signed using **HMAC-SHA256**.

**Headers:**

```http
X-Webhook-Timestamp: <unix timestamp>
X-Webhook-Signature: sha256=<hex signature>
```

**Signature input:**

```
HMAC-SHA256(
    endpoint signing secret,
    "<timestamp>." + <raw request body>
)
```

The payload is serialized once — the exact bytes used to calculate the signature are also sent as the HTTP request body.

### Receiver verification checklist

1. Read the **raw** request body.
2. Recalculate the HMAC using the signing secret.
3. Compare signatures using a **constant-time** comparison.
4. Validate that the timestamp falls within an acceptable tolerance window.
5. Only then parse and process the payload.

> 📄 `scripts/verify-signature.ts` contains the reference verification implementation.

---

## SSRF Protection

Because webhook URLs are user-controlled, the platform validates them **both when stored and immediately before each outbound request.**

<details>
<summary><b>The validator rejects…</b></summary>

- Unsupported URL schemes
- Embedded credentials
- `localhost` and loopback addresses
- Private IPv4 networks
- IPv6 local / private ranges
- Link-local addresses
- CGNAT addresses
- Known cloud metadata IP addresses
- IPv4-mapped IPv6 bypasses
- NAT64-embedded private or metadata addresses
- Malformed hosts

</details>

**Production requires HTTPS.** Local addresses may only be enabled explicitly during development:

```bash
ALLOW_LOCAL_ENDPOINTS=true
```

The application **refuses to start** if this option is enabled with `NODE_ENV=production`.

> [!WARNING]
> **Known limitation:** the validator operates on the literal hostname supplied in the URL and does not perform DNS resolution. DNS rebinding is therefore outside the implemented protection scope.

---

## API Reference

### Endpoint Management

| Method | Route | Description |
|--------|-------|-------------|
| `POST` | `/endpoints` | Register a webhook endpoint |
| `GET` | `/endpoints` | List endpoints |
| `GET` | `/endpoints/:endpointId` | Get an endpoint |
| `PATCH` | `/endpoints/:endpointId` | Update or enable/disable an endpoint |
| `DELETE` | `/endpoints/:endpointId` | Delete an endpoint |

### Subscriptions

| Method | Route | Description |
|--------|-------|-------------|
| `POST` | `/endpoints/:endpointId/subscriptions` | Subscribe to an event type |
| `GET` | `/endpoints/:endpointId/subscriptions` | List subscriptions |
| `DELETE` | `/endpoints/:endpointId/subscriptions/:subscriptionId` | Remove a subscription |

### Events

| Method | Route | Description |
|--------|-------|-------------|
| `POST` | `/events` | Publish an event |
| `GET` | `/events/:eventId` | Get an event |
| `GET` | `/events/:eventId/deliveries` | List deliveries created for an event |

### Deliveries

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/deliveries` | List / filter deliveries |
| `GET` | `/deliveries/:deliveryId` | Get delivery details |
| `GET` | `/deliveries/:deliveryId/attempts` | Get complete attempt history |
| `POST` | `/deliveries/:deliveryId/retry` | Retry a failed delivery |

### Operations

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/metrics` | Retrieve operational metrics |
| `GET` | `/health` | Check application and database health |

> Full interactive documentation is available through **Swagger** at `/docs`.

---

## Metrics

`GET /metrics` calculates operational information directly from PostgreSQL — no external monitoring infrastructure required.

- Total events
- Total deliveries
- Delivered deliveries
- Failed deliveries
- Pending / retrying deliveries
- Success rate
- Average successful-delivery duration

---

## Getting Started

### Prerequisites

- Node.js **22 or later**
- Docker
- Docker Compose

### Setup

```bash
# 1. Clone and enter the project
git clone <repository-url>
cd webhook-platform

# 2. Start PostgreSQL
docker compose up -d

# 3. Create the local configuration
cp .env.example .env

# 4. Install dependencies
npm ci

# 5. Generate the Prisma client
npm run db:generate

# 6. Apply database migrations
npm run db:migrate

# 7. Seed the event-type catalog
npm run db:seed

# 8. Start the application
npm run dev
```

### Where things live

| Resource | URL |
|----------|-----|
| API | http://localhost:3000 |
| Swagger UI | http://localhost:3000/docs |
| OpenAPI JSON | http://localhost:3000/docs/json |
| Health check | http://localhost:3000/health |

> [!TIP]
> **PostgreSQL runs on host port `5433`** (`localhost:5433`), not the usual `5432`, so the development container doesn't conflict with another local PostgreSQL installation. The container itself still uses `5432` internally.

---

## Configuration

All application configuration is centralized in `src/app/config.ts`. The application **fails fast during startup** when required or security-sensitive configuration is missing or invalid.

### Key worker settings

| Variable | Purpose |
|----------|---------|
| `WORKER_POLL_INTERVAL_MS` | How often the worker polls for eligible deliveries |
| `WORKER_CONCURRENCY` | Maximum deliveries processed in parallel |
| `WORKER_BATCH_SIZE` | Number of deliveries claimed per batch |
| `DELIVERY_TIMEOUT_MS` | Outbound HTTP request timeout |
| `MAX_DELIVERY_ATTEMPTS` | Retry budget before a delivery is marked `FAILED` |
| `RETRY_BASE_DELAY_MS` | Base delay for exponential backoff |
| `RETRY_MAX_DELAY_MS` | Upper bound on backoff delay |
| `WORKER_SHUTDOWN_GRACE_MS` | Graceful shutdown window for in-flight work |

> See `.env.example` for the complete configuration.

---

## Testing

Create an isolated test database once:

```bash
docker compose exec postgres createdb -U webhooks webhooks_test
```

Apply migrations:

```bash
DATABASE_URL="postgresql://webhooks:webhooks@localhost:5433/webhooks_test?schema=public" \
node --env-file-if-exists=.env node_modules/.bin/prisma migrate deploy
```

Run the complete test suite:

```bash
DATABASE_URL="postgresql://webhooks:webhooks@localhost:5433/webhooks_test?schema=public" \
npm test
```

Type-check independently:

```bash
npm run typecheck
```

<details>
<summary><b>135 passing automated tests — coverage areas</b></summary>

- Endpoint and subscription management
- URL safety
- Event publication
- Concurrent idempotency
- Transactional fan-out
- Atomic worker claiming
- Delivery concurrency limits
- HMAC signing
- HTTP failure classification
- Retry scheduling
- Lease recovery
- Stale-worker fencing
- Manual retry
- Delivery history
- Metrics
- Receiver-side signature verification
- Full public-API end-to-end delivery flow

</details>

---

## Local End-to-End Demo

**1.** Start the app with the development-only loopback exception enabled:

```bash
ALLOW_LOCAL_ENDPOINTS=true \
DELIVERY_TIMEOUT_MS=2000 \
WORKER_POLL_INTERVAL_MS=300 \
MAX_DELIVERY_ATTEMPTS=3 \
RETRY_BASE_DELAY_MS=500 \
RETRY_MAX_DELAY_MS=2000 \
npm run dev
```

**2.** Start a local receiver:

```bash
node scripts/demo-receiver.ts \
  --port=4000 \
  --mode=success \
  --secret=placeholder
```

**3.** Create an endpoint pointing to `http://127.0.0.1:4000/hook`, subscribe it to an event type such as `order.completed`, then publish an event through `POST /events`.

The worker will then:

```
claim delivery → validate endpoint → sign payload → POST webhook
      → record DeliveryAttempt → transition delivery state
```

**4.** Inspect the result:

```http
GET /deliveries/:deliveryId
GET /deliveries/:deliveryId/attempts
```

> The demo receiver also supports deterministic failure and timeout modes for demonstrating retry handling.

---

## Project Structure

```
src/
├── app/
│   ├── configuration
│   ├── server assembly
│   └── lifecycle
│
├── modules/
│   ├── endpoints/
│   ├── subscriptions/
│   ├── events/
│   ├── deliveries/
│   └── metrics/
│
├── worker/
│   ├── delivery claiming
│   ├── delivery execution
│   ├── retry policy
│   └── lease recovery
│
├── infrastructure/
│   ├── database/
│   ├── http/
│   ├── logging/
│   └── security/
│
└── shared/
    └── errors/

prisma/
├── migrations/
├── schema.prisma
└── seed.ts

scripts/
├── demo-receiver.ts
└── verify-signature.ts

test/
└── unit and integration tests
```

---

## Known Limitations

The project intentionally remains a bounded, internship-scale backend system.

- DNS rebinding is not detected.
- Delivery semantics are at-least-once rather than exactly-once.
- The application runs one worker process locally.
- HTTP failure classification follows a project-defined policy.
- The demo receiver is demonstration infrastructure, not a production webhook consumer.
- There is no dedicated dashboard or frontend.
- There is no external queue broker or distributed monitoring stack.

These constraints are deliberate — they keep the project focused on **webhook reliability, persistence, concurrency, recovery, and security** rather than infrastructure breadth.

---

## Project Status

**✅ Completed** — the implementation covers the full intended internship scope:

```
Endpoint Management → Subscriptions → Event Publication → Transactional Fan-out
    → PostgreSQL-backed Worker → Signed HTTP Delivery → Attempt Recording
    → Automatic Retry → Lease Recovery → Manual Retry → History & Metrics
```

| Verification | Result |
|--------------|--------|
| TypeScript type-check | ✅ PASS |
| Automated tests | ✅ 135 / 135 PASS |
| PostgreSQL migrations | ✅ PASS |
| End-to-end demo | ✅ PASS |
| Repository hygiene | ✅ PASS |

---

## Author

**Muhammed Maruf Ulaş**
Software Engineering · Student No: 230717020 · SE4001
