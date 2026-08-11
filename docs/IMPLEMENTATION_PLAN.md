# Webhook Delivery Platform — Implementation Plan

## 1. Purpose and Authority

This document divides the approved scope into coherent implementation parts.

It sits at authority level 5 as defined in `.claude/CLAUDE.md` section 2. It is
subordinate to `docs/SPEC.md`, `docs/ARCHITECTURE.md`,
`docs/ENGINEERING_RULES.md`, and `docs/PROJECT_CONTEXT.md`. Where this plan and a
higher-authority document appear to disagree, the higher-authority document wins
and the disagreement is reported rather than silently resolved.

This plan introduces no requirement, technology, or architectural pattern that is
not already present in those documents.

---

## 2. How This Plan Is Used

Parts are technical milestones, not calendar days. A part may take several hours
or several days.

Rules for every part:

1. Begin from a repository that builds and whose tests pass.
2. Implement only that part's scope.
3. Satisfy every acceptance criterion before the part is considered done.
4. End with a repository that builds and whose tests pass.
5. Stop. Do not continue into the next part automatically.

Where a later part genuinely requires a foundation, that foundation is built in
the earlier part at the minimum size needed and no larger.

### Schema evolution across parts

The full conceptual data model lives in `SPEC.md` section 6. This plan does not
create it in one migration. Each part migrates only the tables and columns it
actually uses. Several small migrations are preferred over one speculative one;
they also exercise the migration workflow repeatedly, which is a stated project
concern.

The one deliberate exception is the `Delivery` state enum. All five values from
`SPEC.md` section 6 are defined when the enum is first created, because the value
set is specified rather than inferred. Only the transitions belonging to the
current part are implemented, and any other transition is rejected.

---

## 3. Cross-Cutting Decisions

The specification leaves the following open. These are the decisions this plan
adopts, recorded here so they are not re-litigated in every part. Each is
consistent with the authoritative documents; none expands scope. D2 and D4
required explicit agreement before implementation; both were confirmed as
written on 2026-08-11.

**D1 — Event types are a persisted table.** `ARCHITECTURE.md` section 7 lists
"event types where persisted", making persistence optional. A small `EventType`
table is chosen because it gives foreign-key integrity for subscriptions, makes
the unique `(endpoint, eventType)` subscription constraint expressible in the
database, and turns "unsupported event type" into a real constraint rather than
an application-only check. The catalog is seeded, not managed through a public
CRUD API.

**D2 — Idempotency scope.** `Idempotency-Key` is unique across events via a
partial unique index on the non-null key. A replay of the same key with the same
request returns the original event. A replay of the same key with a materially
different request is an idempotency conflict and returns `409`, which is the
error category already named in `SPEC.md` section 19. **Confirmed.**

**D3 — HTTP response classification.** `SPEC.md` section 8 requires retryable
handling of connection failures, timeouts, and `5xx`, and permits the
implementation to define the rest as long as it is documented and consistent. The
rule adopted is: `2xx` succeeds; `408` and `429` are retryable; every other `4xx`
is a permanent failure that goes directly to `FAILED` without consuming the retry
budget; `3xx` is treated as a permanent failure because redirects are not
followed for SSRF reasons.

**D4 — Manual retry and the attempt budget.** `SPEC.md` section 11 requires that
manual retry preserve history and return the delivery to a processable state, but
does not say what happens to the attempt counter. `DeliveryAttempt.attemptNumber`
continues to increase monotonically so history is never renumbered, and the
delivery's automatic-attempt budget is reset so it does not immediately re-fail at
the old limit. Without this the feature would be inert. **Confirmed.**

**D5 — Local receiver and SSRF.** `SPEC.md` section 27 and `ARCHITECTURE.md`
section 29 require a local test receiver, while `SPEC.md` section 15 requires
rejecting localhost. `ENGINEERING_RULES.md` section 17 already sanctions the
resolution: one explicitly named, development-only configuration flag permits
loopback destinations, defaulting to off and rejected under production
configuration. It is never disabled merely to make a test pass.

**D6 — Scheme policy.** `http` and `https` only. `https` is required when the
application runs under production configuration, per `ARCHITECTURE.md` section
21; `http` remains available in development so the local receiver works.

---

## 4. Implementation Parts

### Part 1 — Foundation and Runtime Skeleton

**Goal.** A running, typed, observable application shell with a live database
connection and a working test command, containing no domain behavior.

**Scope.** Node.js LTS with TypeScript in strict mode; Fastify server and
lifecycle; Docker Compose running PostgreSQL; Prisma initialised and connected;
centralized configuration validated at startup; the shared error model and a
single Fastify error handler; structured logging; OpenAPI/Swagger mounted;
`.env.example`; test runner selected and wired to a real database; a minimal
`README` with setup and run steps; a health endpoint.

**Main capabilities introduced.** The application starts, fails fast on invalid
configuration, serves Swagger UI, connects to PostgreSQL, shuts down cleanly, and
can run a test.

**Components likely affected.** `src/app/` (server, config, lifecycle),
`src/shared/errors/`, `src/infrastructure/database/`, `src/infrastructure/logging/`,
`prisma/`, `docker-compose.yml`, `tsconfig.json`, `package.json`, `.env.example`,
`README.md`.

**Dependencies.** None.

**Acceptance criteria.**

- `docker compose up` starts PostgreSQL and the application connects to it.
- The documented start command boots the server and logs a structured startup line.
- `GET /health` returns `200` and reports database reachability.
- Swagger UI is reachable and renders the (currently near-empty) API surface.
- Removing or corrupting a required environment variable aborts startup with a
  clear message and a non-zero exit code — no silent default.
- An unhandled route error returns the shared error shape with no stack trace.
- `tsc --noEmit` passes with strict mode on; the test command runs and passes.
- `.env` and build output are untracked; `.env.example` is tracked.

**High-risk areas.** Low. The only real trap is configuration reaching the code
through scattered `process.env` reads instead of one validated module, which is
hard to unwind later.

**Testing and checks required.** One test that configuration validation rejects
bad input. One test that the error handler produces the shared shape and hides
internals. No further tests at this stage.

**Explicitly excluded.** Every domain model, route, and worker. Authentication.
Containerising the Node application. CI configuration.

---

### Part 2 — Core Schema, Endpoint Management, Subscriptions, URL Safety

**Goal.** Webhook endpoints and their subscriptions can be managed through the
API, with unsafe destinations rejected at the boundary and important invariants
enforced by PostgreSQL.

**Scope.** Prisma models for `WebhookEndpoint`, `EventType`, and `Subscription`
plus the first migration; the centralized URL safety module and its use at
endpoint creation and update; endpoint create/read/list/update/disable/delete with
a CSPRNG-generated signing secret that is never returned by normal responses;
subscription create/list/delete with a unique `(endpointId, eventTypeId)`
constraint; a seeded event type catalog; OpenAPI schemas for all of it.

**Main capabilities introduced.** Endpoint registration and lifecycle,
subscription management, SSRF rejection, database-enforced uniqueness.

**Components likely affected.** `src/modules/endpoints/`,
`src/modules/subscriptions/`, `src/infrastructure/security/url-safety`,
`prisma/schema.prisma`, `prisma/migrations/`, seed script.

**Dependencies.** Part 1 — configuration, error model, Prisma client, error
handler, OpenAPI.

**Acceptance criteria.**

- Migrations apply cleanly to an empty database and the seed populates event types.
- An endpoint can be created, fetched, listed, updated, disabled, and deleted.
- No endpoint response, list entry, log line, or OpenAPI example contains the
  signing secret.
- Creating an endpoint whose URL is `file:`, `localhost`, a loopback address, a
  private-range address, a link-local address, or a malformed host returns `400`
  with a security-category error and creates nothing.
- With the development flag of D5 enabled, a loopback URL is accepted; with
  production configuration the flag cannot take effect.
- A duplicate subscription for the same endpoint and event type returns `409`
  because of the database constraint, not an application pre-check alone.
- A subscription referencing an unknown event type returns `400`.
- Deleting an endpoint behaves per a documented, consistent rule for its
  subscriptions.

**High-risk areas.** SSRF completeness and centralization — the module must be
the single decision point, and it must fail closed. Secret leakage through a
response serializer, a log line, or an OpenAPI example. Getting the uniqueness
constraint into the migration rather than only into application code.

**Testing and checks required.** A table-driven unit test of URL safety covering
allowed and rejected forms including the D5 flag in both positions. An integration
test that the duplicate-subscription constraint is enforced by the database. An
integration test asserting the secret is absent from every endpoint response
shape.

**Explicitly excluded.** Events, deliveries, attempts, any worker, HMAC signing,
and pre-delivery URL revalidation, which belongs to Part 4.

---

### Part 3 — Event Publication, Idempotency, and Delivery Fan-out

**Goal.** An event can be published, is durably persisted together with its full
set of delivery records in one transaction, and is protected against duplicate
creation under concurrent requests — with no outbound HTTP anywhere in the path.

**Scope.** Prisma models for `Event` and `Delivery` (the latter with its full
state enum but only `PENDING` in use) and the migration for them; the partial
unique index backing D2; `POST /events` with schema and domain validation;
subscription matching against enabled endpoints and active subscriptions inside
the transaction; delivery row creation; `Idempotency-Key` handling including the
concurrent-duplicate race; read endpoints for an event and its deliveries.

**Main capabilities introduced.** Durable event publication, transactional
fan-out, database-enforced idempotency.

**Components likely affected.** `src/modules/events/`, `src/modules/deliveries/`
(read side), `prisma/schema.prisma`, `prisma/migrations/`.

**Dependencies.** Part 2 — endpoints, subscriptions, event types.

**Acceptance criteria.**

- `POST /events` with a valid type and payload returns `201` promptly, and the
  response does not depend on any external receiver.
- Exactly one `Delivery` row in `PENDING` exists per enabled endpoint with an
  active subscription to that event's type. Disabled endpoints get none.
- An event with no matching subscription is accepted and creates zero deliveries.
- Event insert and delivery creation are atomic: an induced failure after the
  event insert leaves no event and no partial delivery set.
- Two concurrent requests with the same `Idempotency-Key` produce exactly one
  event and exactly one delivery set; the loser returns the original event rather
  than an error.
- A reused key with a materially different request returns `409` per D2.
- An unknown event type returns `400`; a malformed payload returns `400`.
- No outbound HTTP request is made during publication, and no delivery function
  is reachable from the route.

**High-risk areas.** This part carries two of the project's highest risks.
Idempotency implemented as read-then-insert will pass every sequential test and
fail under concurrency; it must be a caught unique-constraint violation.
Transaction scope must cover the whole fan-out while staying short.

**Testing and criteria required.** An integration test issuing genuinely parallel
requests with the same idempotency key and asserting exactly one event and one
delivery set. An integration test of subscription matching including a disabled
endpoint and a non-subscribing endpoint. An integration test that a forced failure
mid-transaction leaves nothing behind. An assertion that publication performs no
outbound request.

**Explicitly excluded.** The worker, delivery execution, attempt records, retry,
HMAC, manual retry, and metrics.

---

### Part 4 — Delivery Worker: Claiming, Signing, Outbound Delivery, Attempt Recording

**Goal.** A bounded background worker atomically claims pending deliveries,
sends signed webhook requests with a timeout, and records every attempt — with
duplicate execution prevented by PostgreSQL.

**Scope.** `DeliveryAttempt` model and the claim/lease columns on `Delivery`, plus
their migration and supporting indexes; the worker loop with a configurable poll
interval and concurrency limit; the atomic claim using `FOR UPDATE SKIP LOCKED`
in one isolated, parameterized, documented raw query; the outbound HTTP client
with a hard timeout and duration measurement; centralized HMAC-SHA256 signing over
the exact serialized body plus timestamp; pre-delivery URL revalidation; attempt
persistence for every outcome; response classification per D3; transitions
`PENDING → PROCESSING → DELIVERED` and `PROCESSING → FAILED`; failure isolation.

In this part a failed delivery goes directly to `FAILED`. Retry is introduced in
Part 5 and changes only the failure branch. This keeps the repository working at
the end of Part 4 without implementing Part 5 prematurely.

**Main capabilities introduced.** Asynchronous delivery, atomic claiming,
processing leases, signed outbound requests, complete attempt history, bounded
outbound concurrency.

**Components likely affected.** `src/worker/` (loop, claiming),
`src/infrastructure/http/`, `src/infrastructure/security/signing`,
`src/modules/deliveries/`, `prisma/schema.prisma`, `prisma/migrations/`.

**Dependencies.** Part 3 — deliveries exist to be claimed.

**Acceptance criteria.**

- A published event results in a delivered webhook without any API request
  triggering it, and the API response time is unaffected by receiver latency.
- The claim marks rows `PROCESSING` atomically; two concurrent claims for one
  eligible row never both succeed.
- `PROCESSING` rows carry claim time and lease expiry, with the lease longer than
  the delivery timeout.
- Active outbound requests never exceed the configured concurrency limit.
- Every attempt — `2xx`, `5xx`, non-retryable `4xx`, timeout, connection refusal —
  creates exactly one `DeliveryAttempt` with attempt number, timestamp, status,
  HTTP status where available, duration, and error category where applicable.
- A `2xx` response transitions the delivery to `DELIVERED` with a completion
  timestamp; per D3, a failure in this part transitions it to `FAILED`.
- The signature header verifies against the received raw body using the endpoint
  secret; the body signed and the body sent are byte-identical.
- The timestamp is present, signed, and sent.
- A receiver returning `500`, hanging past the timeout, or refusing the connection
  neither crashes the worker nor blocks other deliveries.
- No secret, signature, or full payload appears in any log line or attempt record.
- A delivery whose endpoint URL has become unsafe is rejected before the request.

**High-risk areas.** The highest-risk part in the project. The claim query must be
genuinely atomic. The lease must not be shorter than the timeout, or live
deliveries get reclaimed. The serialize-once rule for signing is the classic
failure that produces intermittently unverifiable signatures. Attempt numbering
must not be derived from a racy count. Concurrency limiting must be a real
semaphore, not an unbounded `Promise.all`.

**Testing and checks required.** Unit tests for signature generation, including a
verification against the exact transmitted bytes. An integration test that two
parallel claim calls return disjoint sets. An integration test per receiver
outcome asserting the persisted attempt and resulting state. A test that
concurrency never exceeds the limit. A test that one failing delivery does not
prevent others from completing.

**Explicitly excluded.** Retry scheduling, backoff, lease recovery, manual retry,
metrics, and delivery filtering.

---

### Part 5 — Retry Lifecycle, Lease Recovery, and Graceful Shutdown

**Goal.** Failed deliveries retry on bounded exponential backoff that survives
restart, exhausted deliveries fail permanently, and deliveries interrupted by a
crash recover without losing history.

**Scope.** `nextAttemptAt` and the automatic-attempt budget columns plus their
migration and index; the isolated retry policy function driven by configuration;
the `PROCESSING → RETRY_SCHEDULED → PROCESSING` path replacing Part 4's
fail-immediately branch; the eligibility query extended to due retries; the
transition to `FAILED` when the budget is exhausted; the lease recovery sweep;
worker-aware graceful shutdown.

**Main capabilities introduced.** Database-backed retry scheduling, bounded
backoff, permanent failure, crash recovery, clean shutdown.

**Components likely affected.** `src/worker/` (retry policy, recovery, loop),
`src/modules/deliveries/` (state transitions), `src/app/lifecycle`,
`prisma/schema.prisma`, `prisma/migrations/`, configuration.

**Dependencies.** Part 4 — claiming, leases, attempts.

**Acceptance criteria.**

- A retryable failure sets `RETRY_SCHEDULED` with a persisted `nextAttemptAt`
  computed by the policy function; no `setTimeout` represents a scheduled retry.
- Delays increase, are bounded by a maximum, and derive from configuration rather
  than literals in business code.
- The worker picks up a due retry and ignores one that is not yet due.
- Restarting the process loses no scheduled retry: after restart the delivery is
  still picked up at its due time.
- Exhausting the configured maximum automatic attempts transitions the delivery to
  `FAILED` with a timestamp, and it is not retried again automatically.
- A delivery whose worker died mid-processing is recovered after its lease expires,
  returns to a processable state, retains every prior `DeliveryAttempt`, and the
  prior attempt still counts toward the budget.
- No delivery can remain in `PROCESSING` indefinitely.
- Recovery cannot reclaim a delivery a live worker still holds.
- Non-retryable outcomes per D3 still go straight to `FAILED` without consuming
  the retry budget.
- On `SIGTERM` the worker stops claiming, bounded in-flight work finishes where
  practical, and Fastify and the database connection close.

**High-risk areas.** Lease expiry versus a slow-but-live delivery. Double-counting
or losing an attempt across recovery. Off-by-one in the attempt limit, producing
one attempt too many or too few. Boundary conditions in the "due now" comparison.
Shutdown that assumes it always succeeds instead of relying on lease recovery.

**Testing and checks required.** Unit tests of the backoff function including its
bound and the exhaustion boundary. Integration tests, with the clock controlled
rather than slept on, for: retry scheduled with the expected `nextAttemptAt`; a
not-yet-due retry skipped; retries surviving a simulated restart; the attempt
limit terminating in `FAILED`; an expired lease recovered with history intact and
the budget correct; a held lease not reclaimed.

**Explicitly excluded.** Manual retry, history query filters, metrics, circuit
breaking, and configurable per-endpoint retry policies.

---

### Part 6 — Manual Retry, Delivery History, and Metrics

**Goal.** The operational surface: a failed delivery can be retried by hand, the
delivery history is queryable with useful filters, and basic metrics are
available.

**Scope.** `POST` manual retry on a delivery with state validation per D4; read
endpoints for deliveries and their attempts with filtering by status, endpoint,
and event, and simple pagination; the metrics endpoint computed by aggregate
PostgreSQL queries; OpenAPI schemas for all of it; any index needed by the new
query patterns.

**Main capabilities introduced.** Manual recovery, operational visibility, basic
metrics.

**Components likely affected.** `src/modules/deliveries/`, `src/modules/metrics/`,
`src/modules/events/` (read side), `prisma/migrations/` if an index is needed.

**Dependencies.** Part 5 — the state machine and attempt budget must be final
before manual retry can re-enter it correctly.

**Acceptance criteria.**

- Manual retry of a `FAILED` delivery returns it to a processable state, and the
  worker delivers it without any further manual action.
- Manual retry preserves every prior `DeliveryAttempt`; numbering continues rather
  than restarting.
- Per D4, the automatic-attempt budget is reset so the retried delivery does not
  immediately re-fail.
- Manual retry of a delivery in `PENDING`, `PROCESSING`, `RETRY_SCHEDULED`, or
  `DELIVERED` is rejected with `409` and changes nothing.
- Manual retry of an unknown delivery returns `404`.
- An event's deliveries, and a delivery's attempts with status, HTTP status,
  timestamp, duration, and error category, are all retrievable.
- Filtering by status, by endpoint, and by event returns correct results, and
  invalid filter values return `400`.
- Metrics report events accepted, deliveries created, delivered, failed,
  pending/retrying, success rate, and average duration, and match the underlying
  rows after a known sequence of operations.
- Every new query pattern is served by an index or is justifiably a sequential
  scan at this scale.

**High-risk areas.** Manual retry re-entering the state machine incorrectly and
either resetting history or immediately re-failing. Metrics that quietly disagree
with the rows they summarise. Filter parameters reaching Prisma without validation.

**Testing and checks required.** Integration tests for manual retry from `FAILED`
through to successful delivery with history preserved, and for rejection from each
invalid state. Integration tests for each filter. One integration test that
asserts metric values against a deterministic fixture.

**Explicitly excluded.** Search, complex query languages, dashboards, event
replay, Prometheus or any metrics infrastructure, and endpoint health summaries.

---

### Part 7 — Test Receiver, Demo Path, Documentation, and Hardening

**Goal.** The system can be demonstrated end to end from documented steps, and
its security and reliability limitations are stated honestly.

**Scope.** The lightweight local test receiver — success, `500`, a delayed
response exceeding the timeout, connection refusal, and signature verification;
the documented demo sequence covering all eleven steps of `SPEC.md` section 27;
completion of the OpenAPI documentation including headers, idempotency behavior,
signing, and error shapes; a receiver-side signature verification example with
constant-time comparison and the timestamp tolerance guidance of `SPEC.md` section
14; `README` setup, run, test, and demo instructions; a short honest statement of
SSRF limitations and the D3 classification rule; a final pass over logs, error
responses, indexes, and repository hygiene.

**Main capabilities introduced.** Reproducible demonstration and complete external
documentation. No new product behavior.

**Components likely affected.** A small `test-receiver` script, `README.md`,
OpenAPI annotations across modules, and existing authoritative documents where
implementation changed documented behavior.

**Dependencies.** Parts 1–6.

**Acceptance criteria.**

- A reader following the `README` on a clean machine can start the database, run
  migrations, seed, start the application, and run the tests.
- The full demo sequence of `SPEC.md` section 27 is reproducible from written
  steps, including simulated failure, observed retries, permanent failure, manual
  retry, history inspection, signature verification, and duplicate protection.
- The receiver-side example verifies a real signature produced by the platform.
- Swagger documents every endpoint, the idempotency header, the signature and
  timestamp headers, and the shared error shape.
- Limitations — DNS rebinding, at-least-once delivery, single-process worker — are
  documented plainly rather than omitted.
- `git ls-files | grep -E '(^|/)(\.claude|\.vscode|\.DS_Store)'` is empty; no
  `.env`, log, build artifact, or local database is tracked.
- No log line or API response contains a secret, a signature, a stack trace, or a
  Prisma internal.
- Every item in `SPEC.md` section 29 is satisfied.

**High-risk areas.** Documentation drifting from the implemented behavior. The
test receiver quietly growing into a framework. A late discovery that a
`Definition of Done` item was never actually implemented — checking section 29
early in this part rather than at its end reduces that risk.

**Testing and checks required.** An end-to-end test exercising the demo path.
A signature verification test using the receiver's own verification code. The
hygiene and secret-leakage checks above. No new large test suite.

**Explicitly excluded.** Every stretch feature. CI pipelines, deployment
automation, containerising the Node application, load testing, and a monitoring UI.

---

## 5. Stretch Features

Not part of the required scope. None begins until Parts 1–7 are complete and
stable, per `SPEC.md` section 28. If time runs out, none of these is missing work.

- Simple circuit breaker on a repeatedly failing endpoint.
- Endpoint-specific rate limiting.
- Endpoint health summary.
- Event replay.
- Small monitoring dashboard.
- Webhook payload filtering.
- Per-endpoint configurable retry policy.

Each would need its own acceptance criteria before implementation, and none may
destabilise the core system.

---

## 6. Risk Register

Ordered by the damage a defect would cause.

| Risk | Part | Why it is dangerous | Control |
|---|---|---|---|
| Idempotency race | 3 | Read-then-insert passes sequential tests and duplicates events under load | Partial unique index; handle the unique violation; parallel-request test |
| Publication consistency | 3 | An accepted event with a partial delivery set silently loses webhooks | Single transaction over insert and fan-out; induced-failure test |
| Duplicate worker execution | 4 | Receivers get the same webhook twice from one attempt | Atomic `SKIP LOCKED` claim; parallel-claim test |
| Serialize-once violation | 4 | Signatures fail verification intermittently and unreproducibly | One serialization, signed and sent; verification against transmitted bytes |
| Lease shorter than timeout | 4/5 | A live delivery is reclaimed and sent twice | Lease bound to timeout by configuration; held-lease test |
| Stranded `PROCESSING` | 5 | Work is lost permanently after a crash | Persisted lease plus recovery sweep; crash-simulation test |
| Lost retries on restart | 5 | Scheduled work disappears | `nextAttemptAt` in PostgreSQL, never `setTimeout`; restart test |
| Attempt-count drift | 5 | Too many or too few attempts; wrong terminal state | Attempt number from persisted state; boundary tests |
| Unbounded concurrency | 4 | One burst exhausts sockets and stalls the system | Configured semaphore; limit assertion test |
| SSRF | 2/4 | Internal network reachable through a user-supplied URL | One centralized fail-closed module; validation at creation and before delivery |
| Secret exposure | 2/4 | Signing secrets leak through responses or logs | Never serialized or logged; explicit tests and a final audit |
| Manual retry mishandling | 6 | History erased, or the retry is inert | D4; history-preservation and invalid-state tests |

---

## 7. Self-Review Against the Authoritative Documents

This plan was checked against each document before being finalised.

**Against `SPEC.md`.** Every numbered goal in section 3 maps to a part: 1–2 to
Part 2, 3–5 to Parts 3 and 4, 6 to Part 4, 7–8 to Part 5, 9 to Part 6, 10 to
Part 3, 11 to Part 4, 12 to Part 6, 13 across Parts 1–6. Every clause of the
`Definition of Done` in section 29 has an owning part. No non-goal from section 4
appears anywhere in the plan.

**Against `ARCHITECTURE.md`.** Single modular monolith; API and worker in one
process with the publication path never invoking delivery; PostgreSQL as the only
durable source of truth; Prisma by default with raw SQL confined to the one
claiming query; retry owned by the delivery lifecycle rather than an HTTP client;
metrics from aggregate queries with no metrics infrastructure. Nothing from the
architecture non-goals in section 34 is present.

**Against `ENGINEERING_RULES.md`.** Testing is targeted at the behaviors listed in
section 21 and nowhere else; no part plans a broad suite. Migrations accompany
every schema change. Transactions stay short and contain no outbound HTTP.
Configuration is centralized and fails fast. No dependency is planned beyond the
required stack, the test runner, and the test receiver.

**Against `PROJECT_CONTEXT.md`.** Seven parts, dependency-ordered rather than
calendar-ordered, each independently verifiable and each leaving a working
repository — within the 5–8 target and sized for one developer over roughly
twenty working days. Required scope is separated from stretch scope.

**Corrections made during this review.**

- An early draft placed retry scheduling inside the worker part. Splitting it into
  Part 5 keeps Part 4 verifiable on its own and avoids building the retry path
  before claiming and leases are proven.
- An early draft created the entire database schema in one migration. Migrating
  per part removes speculative columns and keeps each part's scope honest.
- A separate part for endpoint safety was considered and rejected: URL validation
  belongs where the URL enters the system (Part 2) and where it is used (Part 4),
  not in a part of its own.
- A dedicated observability part was considered and rejected: the specification
  asks for structured logs and aggregate metrics, which fit inside Parts 1 and 6.

**Nothing in this plan introduces** Redis, Kafka, RabbitMQ, microservices,
Kubernetes, GraphQL, event sourcing, a CQRS framework, a distributed cache, a
generic event bus, a dependency-injection container, or a generic repository
abstraction over Prisma.
