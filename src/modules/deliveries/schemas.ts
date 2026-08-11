/**
 * Fastify/OpenAPI schemas for the deliveries module.
 *
 * As with the endpoints module, Fastify's response serializer only emits
 * properties declared here, so no endpoint field — least of all the signing
 * secret — can reach a client through a delivery response.
 */

export const deliveryResponseSchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    eventId: { type: "string", format: "uuid" },
    endpointId: { type: "string", format: "uuid" },
    state: {
      type: "string",
      enum: ["PENDING", "PROCESSING", "RETRY_SCHEDULED", "DELIVERED", "FAILED"],
    },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
  required: ["id", "eventId", "endpointId", "state", "createdAt", "updatedAt"],
  additionalProperties: false,
} as const;

export const listDeliveriesResponseSchema = {
  type: "array",
  items: deliveryResponseSchema,
} as const;
