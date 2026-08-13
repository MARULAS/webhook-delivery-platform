/**
 * Fastify/OpenAPI schema for the metrics module. One flat response, matching
 * the endpoint's full scope (SPEC.md section 18, ARCHITECTURE.md section 25).
 */

export const metricsResponseSchema = {
  type: "object",
  properties: {
    totalEventsAccepted: { type: "integer" },
    totalDeliveriesCreated: { type: "integer" },
    deliveriesDelivered: { type: "integer" },
    deliveriesFailed: { type: "integer" },
    deliveriesPendingOrRetrying: { type: "integer" },
    successRate: { type: "number", nullable: true },
    averageDeliveryDurationMs: { type: "number", nullable: true },
  },
  required: [
    "totalEventsAccepted",
    "totalDeliveriesCreated",
    "deliveriesDelivered",
    "deliveriesFailed",
    "deliveriesPendingOrRetrying",
    "successRate",
    "averageDeliveryDurationMs",
  ],
  additionalProperties: false,
} as const;
