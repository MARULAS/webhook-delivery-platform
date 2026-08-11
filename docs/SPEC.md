# Webhook Delivery Platform — Project Specification

## 1. Project Overview

The Webhook Delivery Platform is a backend-focused service for reliably delivering event notifications from one system to external HTTP endpoints.

Clients can register webhook endpoints, subscribe those endpoints to specific event types, publish events, and inspect delivery outcomes.

The platform is responsible for reliable delivery behavior such as asynchronous processing, retry handling, failure tracking, idempotency, and payload signing.

The project is intentionally designed as a small but technically meaningful backend system rather than a CRUD-heavy business application.

---

## 2. Project Context

This is a solo Software Engineering internship project intended to be completed within approximately 20 working days.

Development will be organized into implementation parts rather than calendar days.

The project should demonstrate practical backend engineering concepts while remaining small enough to finish, test, document, and demonstrate reliably.

The main technical focus is:

* reliable HTTP delivery
* asynchronous processing
* failure handling
* retry behavior
* idempotency
* security
* persistence
* observability

Complexity should come from meaningful system behavior, not from unnecessary infrastructure.

---

## 3. Primary Goals

The system must:

1. Allow webhook endpoints to be registered and managed.
2. Allow endpoints to subscribe to supported event types.
3. Accept events through an HTTP API.
4. Persist events before processing them.
5. Deliver events asynchronously to subscribed endpoints.
6. Record every delivery attempt.
7. Retry failed deliveries according to a defined retry policy.
8. Permanently mark deliveries as failed after the retry limit is exceeded.
9. Allow failed deliveries to be manually retried.
10. Prevent accidental duplicate event creation through idempotency.
11. Sign outbound webhook payloads using HMAC-SHA256.
12. Expose delivery history and basic operational metrics.
13. Handle invalid input and expected failure conditions consistently.

---

## 4. Non-Goals

The project is not intended to become a general-purpose message broker, distributed event platform, or enterprise integration platform.

The following are explicitly out of scope unless later approved as a stretch feature:

* Kafka
* RabbitMQ
* Redis
* Kubernetes
* microservices
* service mesh
* GraphQL
* CQRS frameworks
* event sourcing
* multi-region deployment
* distributed consensus
* exactly-once delivery guarantees
* full workflow orchestration
* complex event transformation
* complex JSONPath filtering
* OAuth/OIDC provider implementation
* billing or subscription management
* full production-grade frontend
* mobile application
* multi-tenant SaaS billing architecture

The system should remain a single deployable application with a background delivery worker.

---

## 5. Actors

### API Client

A system or developer that uses the REST API to:

* manage webhook endpoints
* create subscriptions
* publish events
* inspect events and deliveries
* manually retry failed deliveries

### Webhook Receiver

An external HTTP endpoint that receives webhook requests from the platform.

### Delivery Worker

An internal background process responsible for finding eligible deliveries and attempting HTTP delivery.

---

## 6. Core Domain Model

### WebhookEndpoint

Represents an external HTTP endpoint that can receive webhook events.

Required information:

* unique identifier
* human-readable name
* target URL
* signing secret
* enabled/disabled state
* creation timestamp
* update timestamp

A disabled endpoint must not receive new deliveries.

Secrets must not be exposed through normal API responses.

---

### EventType

Represents a supported event category.

Examples:

* `order.created`
* `order.completed`
* `payment.failed`
* `user.registered`

Event types should use a predictable string naming format.

---

### Subscription

Connects a webhook endpoint to an event type.

A webhook endpoint receives an event only if:

1. the endpoint is enabled, and
2. it has an active subscription to the event's type.

Duplicate subscriptions for the same endpoint and event type must not be allowed.

---

### Event

Represents an event published to the platform.

Required information:

* unique identifier
* event type
* payload
* creation timestamp
* optional idempotency key

The original event payload must be persisted before asynchronous delivery begins.

---

### Delivery

Represents the intended delivery of one event to one webhook endpoint.

A separate Delivery record is created for each matching endpoint.

Possible states should include at least:

* `PENDING`
* `PROCESSING`
* `RETRY_SCHEDULED`
* `DELIVERED`
* `FAILED`

Required information should include:

* associated event
* target endpoint
* current state
* current attempt count
* next eligible retry time where applicable
* creation timestamp
* completion/failure timestamps where applicable

---

### DeliveryAttempt

Represents one actual HTTP delivery attempt.

Each attempt should record enough information to debug delivery behavior.

At minimum:

* delivery identifier
* attempt number
* attempt timestamp
* resulting status
* HTTP status code when available
* request duration
* error category/message when applicable

Sensitive information must not be stored unnecessarily.

---

## 7. Event Publishing

The platform must expose an API for publishing events.

Conceptual request:

```json
{
  "type": "order.completed",
  "payload": {
    "orderId": 5821,
    "amount": 1499
  }
}
```

When an event is accepted:

1. validate the event type and payload
2. apply idempotency rules when an idempotency key exists
3. persist the event
4. identify eligible subscriptions
5. create the corresponding delivery records
6. return without waiting for outbound webhook delivery to finish

Webhook delivery must not happen synchronously inside the event publishing request.

---

## 8. Delivery Processing

The background worker must process eligible deliveries independently from incoming API requests.

Conceptual flow:

```text
PENDING
   |
   v
PROCESSING
   |
   +---- successful 2xx response ----> DELIVERED
   |
   +---- retryable failure ----------> RETRY_SCHEDULED
   |
   +---- retry limit exceeded -------> FAILED
```

A successful delivery is defined as receiving an HTTP `2xx` response from the receiver.

Expected retryable failures include at least:

* connection failures
* request timeouts
* HTTP `5xx` responses

The implementation may define appropriate behavior for other HTTP response categories, but it must remain documented and consistent.

---

## 9. Delivery Timeout

Outbound webhook requests must have a bounded timeout.

A receiver must not be able to occupy a worker indefinitely.

Timeout failures must be recorded as delivery attempts and handled according to the retry policy.

---

## 10. Retry Policy

Failed deliveries must use a bounded retry policy.

The system must support:

* multiple attempts
* increasing delay between attempts
* a maximum number of automatic attempts
* persistence of the next eligible retry time

The retry strategy should use exponential backoff.

Exact delay values are implementation-level configuration and do not need to be embedded permanently in business logic.

Example conceptual progression:

```text
Attempt 1 -> immediate
Attempt 2 -> short delay
Attempt 3 -> longer delay
Attempt 4 -> longer delay
Attempt 5 -> final automatic attempt
```

After the maximum automatic attempts are exhausted, the Delivery enters `FAILED`.

---

## 11. Manual Retry

A failed Delivery must be manually retryable through the API.

A manual retry must:

* preserve existing attempt history
* create a new eligible delivery attempt
* not erase previous failures
* transition the Delivery back into a processable state

The system should reject manual retry when the Delivery is not in an appropriate state.

---

## 12. Idempotency

The event publishing API must support an idempotency key.

Example:

```text
Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000
```

When the same valid idempotency key is reused for the same publishing operation within the supported idempotency scope:

* a duplicate Event must not be created
* duplicate Delivery records must not be created

Idempotency must be enforced reliably at the persistence layer where appropriate, not only through an in-memory check.

---

## 13. Webhook Signing

Outbound webhook requests must be cryptographically signed.

The platform must use:

```text
HMAC-SHA256
```

using the endpoint's secret.

The request must provide enough information for a receiver to verify:

* the payload
* the signature
* the delivery timestamp

The exact header names may be defined during implementation.

The endpoint secret must never be sent as part of the webhook payload.

---

## 14. Basic Replay Protection

Webhook requests should include a delivery timestamp together with the signature.

Documentation should explain that receivers can reject requests whose timestamp falls outside an acceptable tolerance window.

The platform does not need to implement the receiver side of this verification as part of the main product.

A small verification example or test receiver may be used for testing.

---

## 15. Endpoint Safety

Because the system makes outbound HTTP requests to user-configured URLs, endpoint validation must be treated as a security concern.

The project must at minimum consider protection against Server-Side Request Forgery (SSRF).

The implementation should prevent obviously unsafe destinations such as:

* localhost
* loopback IP addresses
* private/local network destinations where practical
* known cloud metadata-style destinations where practical

The internship project does not need to solve every possible DNS rebinding or production-scale SSRF edge case.

The implemented limitations and remaining risks should be documented honestly.

---

## 16. Worker Safety and Concurrency

The worker must avoid processing the same Delivery concurrently under normal operation.

The design should use database-backed coordination rather than relying only on process-local memory.

The worker should also avoid unbounded outbound concurrency.

A configurable concurrency limit or worker-pool-style approach should be used.

The design must consider what happens if a worker begins processing a Delivery and terminates unexpectedly.

The exact recovery strategy is an architectural decision, but Deliveries must not remain permanently stuck in `PROCESSING`.

---

## 17. Delivery History

The API must allow inspection of:

* an Event
* Deliveries generated for an Event
* Delivery state
* Delivery attempt history
* failures
* HTTP response status where available
* attempt timestamps
* duration

Filtering should support useful operational queries such as:

* deliveries by status
* deliveries for a specific endpoint
* deliveries for a specific event

Complex search functionality is not required.

---

## 18. Basic Metrics

The platform should provide basic operational metrics through an API endpoint.

Useful metrics include:

* total events accepted
* total deliveries created
* successful deliveries
* failed deliveries
* pending/retrying deliveries
* success rate
* average delivery duration

Metrics may be derived from PostgreSQL.

A dedicated metrics infrastructure is not required.

---

## 19. Error Handling

The REST API must use a consistent error response format.

Expected error categories include:

* validation failures
* resource not found
* duplicate resource
* invalid state transition
* unsupported event type
* invalid endpoint URL
* idempotency conflict
* internal server error

Internal stack traces and secrets must not be exposed to API clients.

---

## 20. Validation

Validation must happen at system boundaries.

Examples:

* endpoint name must be valid
* endpoint URL must be valid and supported
* event type must be valid
* event payload must be valid JSON
* identifiers must use the expected format
* invalid state transitions must be rejected

Database constraints should also enforce important invariants where appropriate.

---

## 21. Logging

The application must produce useful structured logs for operational events.

Examples:

* application startup
* event accepted
* delivery attempt started
* delivery succeeded
* delivery failed
* retry scheduled
* delivery permanently failed
* manual retry requested

Logs must not contain:

* webhook secrets
* environment secrets
* credentials
* unnecessary sensitive payload data

---

## 22. API Documentation

The application must provide OpenAPI/Swagger documentation.

API documentation should cover:

* endpoints
* request schemas
* response schemas
* common errors
* important headers
* idempotency behavior
* webhook signing behavior

---

## 23. Persistence

PostgreSQL is the primary persistence system.

The system must persist important state required to recover correctly after application restart.

This includes at least:

* endpoints
* subscriptions
* events
* deliveries
* delivery attempts
* retry scheduling state

Application correctness must not depend on important queue state existing only in process memory.

---

## 24. Technology Constraints

Primary stack:

* Node.js
* TypeScript
* Fastify
* PostgreSQL
* Prisma
* Docker Compose
* OpenAPI / Swagger

Testing framework may be selected during project setup.

The TypeScript configuration should use strict type checking.

The project should prefer platform and framework capabilities over unnecessary third-party dependencies.

---

## 25. Deployment Model

The project should remain simple to run locally.

The desired development experience is approximately:

```text
Docker Compose
      |
      +---- PostgreSQL

Node application
      |
      +---- REST API
      |
      +---- Delivery worker
```

API and worker may run within the same application process if the architecture remains clean and failure behavior is acceptable.

A multi-service distributed deployment is not required.

---

## 26. Testing Requirements

Testing should focus on behavior where mistakes would materially affect correctness.

High-value test targets include:

* event publication
* duplicate idempotency keys
* subscription matching
* successful delivery
* timeout/failure handling
* retry scheduling
* retry limit
* manual retry
* HMAC generation/verification
* delivery state transitions
* relevant database constraints
* concurrency-sensitive worker behavior

The project does not require exhaustive unit tests for trivial getters, framework behavior, or basic CRUD wiring.

A smaller set of meaningful integration tests is preferred over a very large low-value test suite.

---

## 27. Demonstration Requirements

The completed system should be demonstrable locally without requiring external paid services.

A demo should be able to show:

1. register a webhook endpoint
2. subscribe it to an event type
3. publish an event
4. observe successful delivery
5. simulate a receiver failure
6. observe recorded attempts and retries
7. observe eventual success or permanent failure
8. manually retry a failed delivery
9. inspect delivery history
10. demonstrate webhook signature verification
11. demonstrate duplicate request protection

A lightweight local webhook receiver may be created solely for demonstration and integration testing.

---

## 28. Stretch Features

Stretch features may only be implemented after the entire required scope is functioning reliably.

Possible stretch features:

* simple circuit breaker behavior
* endpoint-specific rate limiting
* endpoint health summary
* event replay
* small monitoring dashboard
* webhook payload filtering
* configurable retry policies

Stretch features must not destabilize or delay the core system.

---

## 29. Definition of Done

The project is considered functionally complete when:

* the core REST API is operational
* PostgreSQL persistence and migrations work
* endpoints and subscriptions can be configured
* events can be published
* deliveries happen asynchronously
* delivery attempts are persisted
* retry behavior works
* failed deliveries terminate correctly
* manual retry works
* idempotency works
* outbound requests are HMAC signed
* basic endpoint safety protections exist
* worker concurrency is bounded
* interrupted processing can recover
* delivery history is queryable
* basic metrics are available
* OpenAPI documentation exists
* the system can run locally using documented steps
* critical flows have meaningful tests
* the demo flow can be reproduced

---

## 30. Scope Principle

When choosing between two implementations, prefer the solution that is:

1. correct
2. understandable
3. reliable
4. easy to demonstrate
5. appropriately scoped for one developer

Do not add infrastructure, abstractions, patterns, or features solely because they are considered advanced.

A complete, defensible system is more valuable than an unnecessarily complex incomplete one.
