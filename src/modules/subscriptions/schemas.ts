export const subscriptionResponseSchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    endpointId: { type: "string", format: "uuid" },
    eventTypeId: { type: "string", format: "uuid" },
    eventType: { type: "string" },
    createdAt: { type: "string", format: "date-time" },
  },
  required: ["id", "endpointId", "eventTypeId", "eventType", "createdAt"],
  additionalProperties: false,
} as const;

export const listSubscriptionsResponseSchema = {
  type: "array",
  items: subscriptionResponseSchema,
} as const;

export const subscriptionParentParamsSchema = {
  type: "object",
  required: ["endpointId"],
  properties: {
    endpointId: { type: "string", format: "uuid" },
  },
} as const;

export const subscriptionIdParamsSchema = {
  type: "object",
  required: ["endpointId", "subscriptionId"],
  properties: {
    endpointId: { type: "string", format: "uuid" },
    subscriptionId: { type: "string", format: "uuid" },
  },
} as const;

export const createSubscriptionBodySchema = {
  type: "object",
  required: ["eventType"],
  additionalProperties: false,
  properties: {
    eventType: { type: "string", minLength: 1, maxLength: 200 },
  },
} as const;
