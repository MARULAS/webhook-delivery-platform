# Webhook Delivery Platform — Architecture

## 1. Architectural Goal

The system should be a small, reliable backend application that demonstrates asynchronous delivery, persistence, retry behavior, and failure recovery without introducing unnecessary distributed infrastructure.

The architecture should optimize for:

1. correctness
2. simplicity
3. recoverability
4. observability
5. maintainability
6. ease of local demonstration

The project must remain suitable for a solo internship project.

---

## 2. High-Level Architecture

The system consists of two logical runtime responsibilities:

```text
                    ┌───────────────────────┐
                    │      API Clients      │
                    └───────────┬───────────┘
                                │
                                ▼
                    ┌───────────────────────┐
                    │     Fastify REST API  │
                    └───────────┬───────────┘
                                │
                                ▼
                    ┌───────────────────────┐
                    │      PostgreSQL       │
                    │                       │
                    │ Events                │
                    │ Subscriptions         │
                    │ Deliveries            │
                    │ Delivery Attempts     │
                    └───────────┬───────────┘
                                ▲
                                │
                    ┌───────────┴───────────┐
                    │    Delivery Worker    │
                    └───────────┬───────────┘
                                │
                                ▼
                    ┌───────────────────────┐
                    │ External HTTP Targets │
                    └───────────────────────┘
```

The REST API and delivery worker belong to the same application and codebase.

They may initially run in the same Node.js process.

The architecture must preserve enough separation that they could later run independently without a major rewrite, but separate deployment is not a project requirement.

---

## 3. Deployment Style

The application is a modular monolith.

Do not split the project into microservices.

The local development model should remain approximately:

```text
Node.js Application
├── HTTP API
└── Background Delivery Worker

PostgreSQL
```

Docker Compose should be used for local infrastructure, primarily PostgreSQL.

Containerizing the Node.js application is acceptable but not required during early development.

---

## 4. Technology Stack

Required technologies:

* Node.js
* TypeScript
* Fastify
* Prisma
* PostgreSQL
* Docker Compose
* OpenAPI / Swagger

The project should use a currently supported Node.js LTS release.

TypeScript strict mode must be enabled.

Additional libraries should only be added when they solve a concrete requirement more cleanly than the standard platform or selected framework.

---

## 5. Application Structure

The system should be organized primarily by domain/module rather than by global technical layer.

Recommended conceptual structure:

```text
src/
├── app/
│   ├── server
│   ├── configuration
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
│   ├── delivery-worker
│   ├── delivery-claiming
│   ├── retry-policy
│   └── recovery
│
├── infrastructure/
│   ├── database/
│   ├── http/
│   ├── logging/
│   └── security/
│
└── shared/
    ├── errors/
    ├── validation/
    └── types/
```

Exact file names may differ.

The important rule is that related behavior should remain close together.

Avoid creating excessive layers such as:

```text
controller
service
manager
processor
handler
repository
facade
helper
```

for every feature without a demonstrated need.

---

## 6. API Architecture

Fastify owns the HTTP boundary.

Routes are responsible for:

* parsing input
* request validation
* authentication/authorization if introduced
* mapping application results to HTTP responses

Routes should not contain substantial business logic.

Business behavior should live in module-level application/domain functions or services.

Prisma calls should not be scattered arbitrarily throughout route handlers.

---

## 7. Database as Durable Source of Truth

PostgreSQL is the durable source of truth for delivery processing.

Important delivery state must not exist only in:

* memory
* timers
* JavaScript queues
* process-local collections

Application restart must not cause pending or retryable deliveries to disappear.

The database stores at least:

* endpoints
* event types where persisted
* subscriptions
* events
* deliveries
* delivery attempts
* retry scheduling state

---

## 8. Event Publishing Transaction

Publishing an event should preserve consistency between the Event and its generated Deliveries.

The preferred logical operation is:

```text
BEGIN

1. validate idempotency
2. insert Event
3. identify matching active subscriptions
4. create Delivery rows

COMMIT
```

Where practical, this operation should be performed transactionally.

The API must not return an accepted event whose required Delivery records were only partially created due to an unexpected failure.

---

## 9. Worker Model

The worker repeatedly searches for Deliveries eligible for processing.

Conceptually:

```text
find eligible deliveries
        ↓
claim limited batch
        ↓
mark claimed deliveries as PROCESSING
        ↓
perform outbound requests
        ↓
persist attempts
        ↓
transition delivery state
```

The worker should process a bounded number of deliveries concurrently.

Unbounded `Promise.all()` over all pending deliveries is not acceptable.

---

## 10. Delivery Claiming

Worker coordination must rely on PostgreSQL.

The architecture should use an atomic claiming strategy so that two workers do not normally execute the same Delivery simultaneously.

A suitable PostgreSQL strategy may use concepts such as:

```sql
FOR UPDATE SKIP LOCKED
```

or another atomic database-backed claim mechanism.

Because Prisma may not expose every required locking primitive elegantly, narrowly scoped raw SQL is acceptable for delivery claiming if:

* parameterization is used
* the query is isolated
* its purpose is documented
* the rest of the persistence layer continues using Prisma normally

Do not replace Prisma globally because of one concurrency-sensitive operation.

---

## 11. Processing Lease / Recovery

A Delivery in `PROCESSING` must have enough metadata to determine whether the worker that claimed it is likely no longer processing it.

The design should support a bounded processing lease or equivalent mechanism.

Conceptually:

```text
PROCESSING
claimedAt = T
leaseUntil = T + duration
```

If the application terminates unexpectedly and the lease expires, the Delivery becomes recoverable.

Recovery must not erase DeliveryAttempt history.

Exact field names and recovery intervals are implementation details.

---

## 12. Outbound Concurrency

Outbound webhook traffic must use bounded concurrency.

The application should expose a configurable worker concurrency value.

Example conceptual limit:

```text
maximum active outbound requests = N
```

The exact default may be chosen during implementation.

Concurrency control should be implemented simply.

Do not introduce a third-party distributed queue solely to obtain concurrency limiting.

---

## 13. HTTP Delivery Client

Outbound requests should use the Node.js standard HTTP capabilities or the HTTP client already provided by the chosen runtime/framework ecosystem.

The client must support:

* request timeout
* POST requests
* JSON payload
* custom webhook headers
* status-code inspection
* request duration measurement
* AbortSignal / cancellation where appropriate

Retries must not be hidden inside a generic HTTP library retry feature.

Retry behavior belongs to the platform's Delivery lifecycle and must remain visible and persisted.

---

## 14. Retry Scheduling

Retry scheduling is database-backed.

A retryable Delivery should store the next time it becomes eligible for processing.

Example:

```text
state = RETRY_SCHEDULED
nextAttemptAt = timestamp
```

The worker queries only deliveries whose retry time is due.

Do not rely on one long-lived `setTimeout()` per retry.

That would lose scheduled retries after process restart.

---

## 15. Retry Policy

Retry calculation should be isolated from delivery execution.

Conceptually:

```text
calculateNextRetry(attemptNumber)
```

The policy should implement bounded exponential backoff.

Configuration should define values such as:

* maximum automatic attempts
* base retry delay
* maximum retry delay
* request timeout

Business code should not contain duplicated retry timing literals.

Jitter may be included if it remains simple and testable.

---

## 16. Delivery State Transitions

Delivery state changes should be explicit.

Typical transitions:

```text
PENDING
    ↓
PROCESSING
    ↓
DELIVERED
```

or:

```text
PROCESSING
    ↓
RETRY_SCHEDULED
    ↓
PROCESSING
```

or:

```text
PROCESSING
    ↓
FAILED
```

Manual retry:

```text
FAILED
    ↓
PENDING / RETRY_SCHEDULED
```

Invalid transitions must be rejected rather than silently coerced.

State-transition logic should not be duplicated across unrelated modules.

---

## 17. Delivery Attempt Recording

Every actual outbound HTTP attempt must create a DeliveryAttempt record.

The attempt should be persisted regardless of whether the result was:

* success
* HTTP error response
* timeout
* connection error

Delivery state and DeliveryAttempt persistence should remain consistent.

Where necessary, database transactions should be used when updating the Delivery and recording the resulting attempt.

---

## 18. Idempotency Architecture

Idempotency must have database-level enforcement.

An in-memory lookup is not sufficient.

The idempotency model should allow an API retry to return or reference the already-created Event instead of creating another event and another set of Deliveries.

The selected uniqueness constraint must reflect the intended idempotency scope.

The implementation should handle race conditions where two requests with the same idempotency key arrive concurrently.

---

## 19. HMAC Signing

Webhook signing belongs to the outbound delivery infrastructure.

Signature generation should be centralized rather than recreated independently by worker code.

Inputs should include:

* serialized request payload
* webhook secret
* delivery timestamp

Use Node.js cryptographic primitives.

Secrets must not be persisted in DeliveryAttempt records or logs.

The signature algorithm is:

```text
HMAC-SHA256
```

---

## 20. Payload Serialization

The exact byte representation used for signature generation must match the outbound request body.

The implementation must avoid this failure:

```text
sign(JSON.stringify(payload A))
send(JSON.stringify(payload B))
```

where serialization differences cause verification failures.

Generate the serialized request body once, sign that representation, and send the same representation.

---

## 21. Endpoint URL Security

Outbound endpoint validation should be centralized.

The validation layer should reject clearly unsafe destinations before delivery.

At minimum, the architecture must consider:

* unsupported URL schemes
* localhost
* loopback addresses
* private/local IP ranges
* malformed hostnames

Only `http` and `https` may be considered, with production-oriented behavior preferring HTTPS.

SSRF defenses should not be scattered through route and worker code.

---

## 22. Error Model

The application should define a small shared application error model.

Examples:

```text
ValidationError
NotFoundError
ConflictError
InvalidStateError
SecurityError
```

Infrastructure errors should be translated appropriately at application boundaries.

Do not expose raw Prisma errors or stack traces directly through the REST API.

---

## 23. Validation Architecture

Fastify request schemas should validate external request shape.

Application-level validation should enforce domain rules that cannot be expressed adequately as simple schema validation.

PostgreSQL constraints should enforce critical invariants such as uniqueness.

Use each layer for the type of validation it handles best.

Do not duplicate every rule in every layer unnecessarily.

---

## 24. Logging Architecture

Use structured application logging.

Fastify's logging ecosystem should be preferred unless there is a concrete reason to replace it.

Important logs should contain useful context such as:

* event ID
* endpoint ID
* delivery ID
* attempt number
* resulting state
* duration

Logs must not contain endpoint secrets.

Full webhook payload logging should be avoided by default.

---

## 25. Metrics Architecture

Basic project metrics should be derived primarily from persisted data.

Do not introduce Prometheus, Grafana, Elasticsearch, or a separate analytics database as core requirements.

Metrics endpoints may perform aggregate PostgreSQL queries.

If aggregate queries become expensive at internship scale, optimize only when evidence warrants it.

---

## 26. Configuration

Environment-specific configuration should be centralized.

Typical configuration:

```text
DATABASE_URL
PORT
WORKER_ENABLED
WORKER_POLL_INTERVAL
WORKER_CONCURRENCY
DELIVERY_TIMEOUT
MAX_DELIVERY_ATTEMPTS
RETRY_BASE_DELAY
```

Exact names may differ.

Configuration should:

* be validated at startup
* fail fast when required values are invalid
* never silently fall back to unsafe values

Provide `.env.example`.

Real `.env` files must not be committed.

---

## 27. Prisma Usage

Prisma is the default database access layer.

Use it for:

* standard reads
* standard writes
* migrations
* transactions
* relations
* normal filtering

Raw SQL should remain exceptional and localized to cases where PostgreSQL capabilities are materially useful, especially worker claiming/concurrency.

Avoid building a custom generic repository abstraction over Prisma unless a real need emerges.

---

## 28. Database Constraints and Indexes

Important invariants should be represented in the schema.

Likely constraints/indexing needs include:

* unique subscription per endpoint/event type
* idempotency uniqueness
* indexes for Delivery status
* indexes for `nextAttemptAt`
* indexes used by worker claiming queries
* foreign-key integrity

Indexes should be justified by actual access patterns.

Do not create indexes on every column.

---

## 29. Testing Architecture

Testing should favor behavior over implementation details.

Preferred categories:

### Unit tests

Suitable for isolated logic such as:

* retry calculation
* state-transition validation
* HMAC signature generation
* URL safety utilities

### Integration tests

Suitable for:

* publishing an Event
* idempotency race handling
* creating Deliveries
* worker processing
* retry lifecycle
* DeliveryAttempt persistence
* database constraints

### Test Receiver

A lightweight local HTTP receiver may be used to simulate:

* successful responses
* HTTP 500
* delayed responses/timeouts
* signature verification

Do not build a large testing framework around this receiver.

---

## 30. Failure Philosophy

Expected failures are part of normal system behavior.

The platform should distinguish between:

```text
receiver failure
platform/application failure
invalid input
invalid state
```

A receiver returning HTTP 500 should not produce an application-level crash.

A delivery timeout should not terminate the worker.

Unexpected errors must be logged and isolated so that one broken Delivery does not stop processing all others.

---

## 31. Graceful Shutdown

The Node.js application should support graceful shutdown.

On termination:

* stop accepting unnecessary new worker claims
* allow bounded in-flight work to finish where practical
* close Fastify
* close database connections

The system must still rely on persisted recovery logic rather than assuming graceful shutdown always succeeds.

---

## 32. API and Worker Separation Rule

Although the API and worker may run in the same process, their responsibilities must remain logically separate.

API code must not directly call:

```text
deliverWebhook()
```

as part of the event publishing request.

Publishing persists work.

The worker executes work.

This separation is a core architectural invariant.

---

## 33. Dependency Policy

Before adding a dependency, determine whether the requirement can already be solved cleanly using:

* Node.js
* Fastify
* Prisma
* PostgreSQL

Dependencies are acceptable when they reduce meaningful complexity.

Dependencies should not be added merely to avoid writing a small amount of understandable code.

Avoid infrastructure dependencies whose operational burden exceeds their value for this project's scope.

---

## 34. Architecture Non-Goals

Do not implement architectural patterns simply for portfolio appearance.

Specifically avoid introducing:

* generic domain-event buses
* home-grown dependency injection containers
* abstract repository frameworks
* multiple application services for trivial operations
* plugin architectures
* microservices
* distributed caches
* message brokers
* Kubernetes
* generic workflow engines
* CQRS/event-sourcing frameworks

The project already contains sufficient engineering depth through reliability and concurrency behavior.

---

## 35. Evolution Rule

Architecture changes are allowed when implementation reveals a genuine problem.

However:

1. the problem must be identified explicitly
2. the simpler existing design must be shown inadequate
3. the proposed change must remain inside SPEC scope
4. relevant documentation must be updated

Do not silently redesign the system during implementation.

---

## 36. Architectural Success Criteria

The architecture is successful when:

* API response latency does not depend on external webhook receivers
* pending work survives application restarts
* retries survive application restarts
* duplicate worker execution is controlled
* outbound concurrency is bounded
* failed requests produce useful DeliveryAttempt history
* worker crashes do not permanently strand Deliveries
* idempotency remains correct under concurrent requests
* webhook signatures are reproducible and verifiable
* the application remains understandable to one developer
* the project can be demonstrated with PostgreSQL and a local test receiver without additional distributed infrastructure
