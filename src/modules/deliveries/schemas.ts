/**
 * Fastify/OpenAPI schemas for the deliveries module.
 *
 * As with the endpoints module, Fastify's response serializer only emits
 * properties declared here, so no endpoint field — least of all the signing
 * secret — can reach a client through a delivery response.
 */

const DELIVERY_STATES = ["PENDING", "PROCESSING", "RETRY_SCHEDULED", "DELIVERED", "FAILED"] as const;

export const deliveryResponseSchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    eventId: { type: "string", format: "uuid" },
    endpointId: { type: "string", format: "uuid" },
    state: { type: "string", enum: DELIVERY_STATES },
    attemptCount: { type: "integer" },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
    nextAttemptAt: { type: "string", format: "date-time", nullable: true },
    completedAt: { type: "string", format: "date-time", nullable: true },
    failureReason: { type: "string", nullable: true },
  },
  required: [
    "id",
    "eventId",
    "endpointId",
    "state",
    "attemptCount",
    "createdAt",
    "updatedAt",
    "nextAttemptAt",
    "completedAt",
    "failureReason",
  ],
  additionalProperties: false,
} as const;

export const listDeliveriesResponseSchema = {
  type: "array",
  items: deliveryResponseSchema,
} as const;

export const deliveryIdParamsSchema = {
  type: "object",
  required: ["deliveryId"],
  properties: {
    deliveryId: { type: "string", format: "uuid" },
  },
} as const;

/**
 * Bounded, simple pagination (IMPLEMENTATION_PLAN.md Part 6, ENGINEERING_RULES.md
 * section 4): `limit`/`offset` rather than a cursor. There is no existing
 * pagination convention in this codebase and the project's scale does not
 * justify cursor pagination's added complexity. AJV coerces numeric query
 * strings and applies `default`, and rejects anything else (e.g. `limit=abc`)
 * as a schema validation failure, which the shared error handler already maps
 * to 400.
 */
export const listDeliveriesQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: DELIVERY_STATES },
    endpointId: { type: "string", format: "uuid" },
    eventId: { type: "string", format: "uuid" },
    limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
    offset: { type: "integer", minimum: 0, default: 0 },
  },
} as const;

export const deliveryAttemptResponseSchema = {
  type: "object",
  properties: {
    attemptNumber: { type: "integer" },
    attemptedAt: { type: "string", format: "date-time" },
    outcome: { type: "string", enum: ["SUCCESS", "RETRYABLE_FAILURE", "PERMANENT_FAILURE"] },
    httpStatusCode: { type: "integer", nullable: true },
    durationMs: { type: "integer" },
    errorCategory: { type: "string", enum: ["HTTP_STATUS", "TIMEOUT", "CONNECTION_ERROR"], nullable: true },
    errorMessage: { type: "string", nullable: true },
  },
  required: [
    "attemptNumber",
    "attemptedAt",
    "outcome",
    "httpStatusCode",
    "durationMs",
    "errorCategory",
    "errorMessage",
  ],
  additionalProperties: false,
} as const;

export const listDeliveryAttemptsResponseSchema = {
  type: "array",
  items: deliveryAttemptResponseSchema,
} as const;
