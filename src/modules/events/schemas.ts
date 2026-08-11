/**
 * Fastify/OpenAPI schemas for the events module.
 */

export const eventResponseSchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    type: { type: "string" },
    payload: { type: "object", additionalProperties: true },
    idempotencyKey: { type: "string", nullable: true },
    createdAt: { type: "string", format: "date-time" },
  },
  required: ["id", "type", "payload", "createdAt"],
  additionalProperties: false,
} as const;

export const eventIdParamsSchema = {
  type: "object",
  required: ["eventId"],
  properties: {
    eventId: { type: "string", format: "uuid" },
  },
} as const;

export const publishEventBodySchema = {
  type: "object",
  required: ["type", "payload"],
  additionalProperties: false,
  properties: {
    type: { type: "string", minLength: 1, maxLength: 200 },
    // The payload must be a JSON object (SPEC.md section 7 shows one); its
    // internal shape belongs to the publisher, so it is not constrained
    // further.
    payload: { type: "object", additionalProperties: true },
  },
} as const;

// Header schemas must not set `additionalProperties: false` — every request
// also carries content-type, host, and similar headers, and rejecting them
// would reject every request. The bound on length keeps an unbounded
// caller-supplied string out of the database.
export const publishEventHeadersSchema = {
  type: "object",
  properties: {
    "idempotency-key": { type: "string", minLength: 1, maxLength: 255 },
  },
} as const;
