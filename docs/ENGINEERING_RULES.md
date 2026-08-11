# Webhook Delivery Platform — Engineering Rules

## 1. Purpose

This document defines the engineering standards for the project.

These rules apply to all implementation work unless they conflict with a higher-authority project document.

The goal is not maximum architectural sophistication.

The goal is a correct, secure, understandable, maintainable, and demonstrable internship project.

---

## 2. Priority Order

When trade-offs exist, prefer:

1. correctness
2. adherence to the project specification
3. security
4. simplicity
5. maintainability
6. observability
7. performance where it materially matters
8. token and implementation efficiency

Do not sacrifice correctness or security merely to save time or tokens.

Do not sacrifice simplicity merely to make the code appear more advanced.

---

## 3. TypeScript Rules

TypeScript must use strict mode.

Avoid:

* `any`
* unsafe type assertions
* broad `unknown` casting without validation
* non-null assertions used to silence real problems

If `any` or a risky assertion is genuinely necessary, its reason should be clear from the surrounding code.

Prefer explicit domain types for meaningful concepts.

Do not create type wrappers for trivial values unless they improve correctness.

---

## 4. Code Simplicity

Prefer direct and readable implementations.

Avoid unnecessary:

* inheritance
* base classes
* generic frameworks
* factories
* managers
* facades
* adapters
* builders
* interfaces with only one implementation
* dependency injection abstractions
* helper layers

Create abstractions only after a concrete duplication, boundary, or complexity problem exists.

Do not pre-build abstractions for hypothetical future requirements.

---

## 5. Module Boundaries

Keep domain behavior close to the module that owns it.

Examples:

* event publication logic belongs with events
* retry policy belongs with delivery processing
* HMAC logic belongs with webhook security/delivery infrastructure
* endpoint URL safety belongs in one centralized security component

Do not move behavior into a shared module merely because two files use it.

The `shared` area should remain small.

---

## 6. Route Rules

Fastify route handlers should remain thin.

They should primarily:

* accept input
* invoke validation/application logic
* map results to HTTP responses

Substantial business logic must not live directly inside route handlers.

Database operations should not be scattered across routes.

---

## 7. Database Rules

PostgreSQL is responsible for durable state and important integrity guarantees.

Use database constraints for important invariants where appropriate.

Examples:

* unique subscriptions
* foreign-key relationships
* idempotency uniqueness

Do not rely solely on application-side checks when concurrent requests could violate correctness.

All schema changes must use migrations.

Do not manually alter the database schema as part of normal development.

---

## 8. Prisma Rules

Prisma is the default persistence layer.

Do not create a generic repository framework over Prisma.

Raw SQL is acceptable only when:

* Prisma cannot express the required behavior cleanly
* PostgreSQL-specific behavior materially improves correctness
* the query is narrow and isolated
* parameters are safely bound

Concurrency-sensitive delivery claiming is an acceptable example.

---

## 9. Transaction Rules

Use transactions when multiple database operations must succeed or fail together.

Do not wrap unrelated operations in large transactions.

Keep transaction duration short.

Never perform slow external HTTP calls while holding a database transaction open unless there is a proven correctness requirement.

Outbound webhook delivery must not occur inside the event publication transaction.

---

## 10. Concurrency Rules

Concurrency must be bounded.

Do not:

* fetch every pending delivery and start them all simultaneously
* use unlimited `Promise.all()`
* depend only on process memory to prevent duplicate execution

Worker claiming must remain database-backed.

Concurrency bugs should be treated as correctness bugs, not rare edge cases.

---

## 11. Async Work Rules

Persistent asynchronous work must be represented in PostgreSQL.

Do not use process-local queues as the durable source of truth.

Do not use long-lived `setTimeout()` instances to represent scheduled retries.

Application restart must not erase pending work.

---

## 12. HTTP Client Rules

All outbound requests must have a timeout.

Receiver failures must not crash the worker.

HTTP error categories must be handled intentionally.

Do not use hidden automatic retry behavior inside an HTTP client library.

The delivery system owns retry decisions.

---

## 13. Error Handling

Expected errors should use consistent application-level error handling.

Do not:

* expose raw stack traces to clients
* expose Prisma internals through API responses
* silently swallow unexpected failures
* catch errors only to ignore them

Unexpected errors should be logged with enough context to debug them.

Receiver failure and application failure are different categories and should remain distinguishable.

---

## 14. API Rules

Use appropriate HTTP semantics.

Examples:

* `200` / `201` for successful operations as appropriate
* `400` for invalid requests
* `404` for missing resources
* `409` for meaningful conflicts
* `500` only for unexpected server-side failures

Do not return `200 OK` for failed business operations.

Use a consistent error response structure.

---

## 15. Validation Rules

Validate external input at system boundaries.

Validation should be placed at the appropriate layer:

* shape/schema validation at the API boundary
* domain rules in application logic
* persistence invariants in PostgreSQL

Avoid copy-pasting the same validation rule across multiple layers without a reason.

---

## 16. Security Rules

Secrets must never be:

* logged
* committed to Git
* returned through normal API responses
* included in error messages

Use environment variables for secrets and environment-specific configuration.

Webhook signing must use established Node.js cryptographic functionality.

Do not implement custom cryptographic algorithms.

Security validation must fail closed when practical.

---

## 17. SSRF Rules

Outbound webhook destinations are untrusted input.

Endpoint safety checks must be centralized.

At minimum, the implementation should reject clearly unsafe destinations according to the project specification.

Do not disable endpoint safety merely to make testing easier.

Local testing exceptions, if required, must be explicit and development-only.

---

## 18. Logging Rules

Use structured logs.

Prefer useful identifiers:

* event ID
* endpoint ID
* delivery ID
* attempt number

Avoid logging entire request or webhook payload bodies by default.

Do not log secrets or authorization values.

Logs should help diagnose failures without exposing sensitive data.

---

## 19. Configuration Rules

Configuration must be centralized and validated on startup.

Invalid critical configuration should fail fast.

Do not scatter direct `process.env` access across the application.

Do not silently accept malformed configuration.

---

## 20. Dependency Rules

Before adding a dependency, ask:

1. Is the requirement already solved adequately by Node.js?
2. Is it already solved by Fastify?
3. Is it already solved by Prisma?
4. Is it already solved by PostgreSQL?
5. Does the dependency reduce meaningful complexity?

Avoid adding dependencies for trivial helpers.

Do not add:

* Kafka
* RabbitMQ
* Redis
* Kubernetes-related libraries
* GraphQL
* CQRS/event-sourcing frameworks

unless project scope is explicitly changed.

---

## 21. Testing Philosophy

Tests should protect important behavior.

Prioritize:

* retry calculations
* delivery state transitions
* idempotency
* HMAC signing
* URL safety
* subscription matching
* delivery success/failure behavior
* worker claiming
* concurrency-sensitive database behavior
* recovery behavior
* important database constraints

Do not write tests merely to increase coverage percentage.

Do not test:

* trivial getters/setters
* framework behavior already guaranteed by Fastify/Prisma
* implementation details with no behavioral value

A smaller high-value test suite is preferred.

---

## 22. Test Scope Discipline

Every implementation part should include enough testing to establish confidence in the new behavior.

Do not stop feature development to build a large generalized testing framework.

Do not generate hundreds of tests for a project of this size.

When a bug is found in important behavior, add a focused regression test when practical.

---

## 23. Documentation Rules

Documentation should explain:

* decisions
* externally visible behavior
* non-obvious architecture
* setup and operation
* important security/reliability limitations

Do not document obvious lines of code.

Do not create documentation files solely for appearance.

Keep existing authoritative documents synchronized when behavior changes.

---

## 24. Comment Rules

Prefer readable code over explanatory comments.

Comments are appropriate for:

* non-obvious concurrency logic
* security-sensitive reasoning
* unusual PostgreSQL behavior
* why a constraint exists
* intentional trade-offs

Avoid comments that merely restate the code.

---

## 25. Refactoring Rules

Do not refactor working code merely because a different style is preferred.

Refactor when it materially improves:

* correctness
* clarity
* maintainability
* security
* testability

Avoid large unrelated refactors while implementing a feature.

A task should not modify large unrelated areas of the repository without a concrete reason.

---

## 26. Scope Discipline

Implement only the currently approved project scope.

Do not silently add:

* new infrastructure
* new architectural patterns
* unrelated features
* speculative extensibility

Stretch features begin only after the required scope is complete and stable.

---

## 27. Implementation-Part Discipline

The project is implemented in coherent parts rather than calendar days.

Each implementation part should:

* have one clear goal
* have defined acceptance criteria
* leave the repository in a working state
* avoid prematurely implementing future parts

If future work is necessary to support current architecture, create only the minimum required foundation.

---

## 28. Token-Efficiency Rules

Use reasoning and output budget primarily for:

* implementation
* debugging
* concurrency correctness
* security-sensitive behavior
* architecture-critical decisions

Use fewer tokens for:

* repetitive explanations
* large test matrices
* verbose documentation
* restating existing project documents
* summaries that do not change the next action

Token efficiency must not reduce required features, correctness, security, or meaningful UX/API quality.

---

## 29. Git Hygiene

The repository must not contain machine-specific or local development artifacts.

Do not commit:

* `.DS_Store`
* `.vscode/`
* local workspace files
* `.env`
* logs
* temporary files
* build artifacts
* dependencies
* local AI-tool configuration

The repository `.gitignore` is authoritative for repository-local exclusions.

Before important pushes, inspect tracked files for accidental local artifacts.

---

## 30. AI Tooling Boundary

Local AI-assistant configuration must remain separate from normal project source and documentation.

Local AI tooling must not become a runtime dependency of the application.

The production application must remain fully understandable and runnable without access to local assistant configuration.

---

## 31. Definition of Good Engineering for This Project

A solution is considered good when:

* it works correctly under expected failure conditions
* important state survives restart
* concurrency is controlled
* security basics are respected
* the behavior is understandable
* the code is reasonably easy to modify
* the project can be demonstrated clearly
* unnecessary infrastructure was avoided

More code is not automatically better engineering.

More architecture is not automatically better engineering.

A deliberate, reliable, bounded solution is preferred.
