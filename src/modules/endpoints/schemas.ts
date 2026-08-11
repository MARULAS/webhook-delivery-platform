/**
 * Fastify/OpenAPI schemas for the endpoints module.
 *
 * `endpointResponseSchema` deliberately has no `signingSecret` property.
 * Fastify's response serializer (fast-json-stringify) only emits properties
 * declared in the schema, so even if application code ever accidentally
 * included the secret on a returned object, it could not reach the client
 * through this schema.
 */

export const endpointResponseSchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    name: { type: "string" },
    url: { type: "string" },
    enabled: { type: "boolean" },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
  required: ["id", "name", "url", "enabled", "createdAt", "updatedAt"],
  additionalProperties: false,
} as const;

export const endpointIdParamsSchema = {
  type: "object",
  required: ["endpointId"],
  properties: {
    endpointId: { type: "string", format: "uuid" },
  },
} as const;

export const createEndpointBodySchema = {
  type: "object",
  required: ["name", "url"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 200 },
    url: { type: "string", minLength: 1, maxLength: 2048 },
    enabled: { type: "boolean" },
  },
} as const;

// Every field is optional, but at least one must be present — an empty
// PATCH body is rejected at the schema boundary rather than silently
// accepted as a no-op.
export const updateEndpointBodySchema = {
  type: "object",
  minProperties: 1,
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 200 },
    url: { type: "string", minLength: 1, maxLength: 2048 },
    enabled: { type: "boolean" },
  },
} as const;

export const listEndpointsResponseSchema = {
  type: "array",
  items: endpointResponseSchema,
} as const;
