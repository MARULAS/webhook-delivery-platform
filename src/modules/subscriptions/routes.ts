import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "../../infrastructure/database/prisma.ts";
import { errorResponseSchema } from "../../shared/errors/error-schema.ts";
import {
  createSubscriptionBodySchema,
  listSubscriptionsResponseSchema,
  subscriptionIdParamsSchema,
  subscriptionParentParamsSchema,
  subscriptionResponseSchema,
} from "./schemas.ts";
import { createSubscription, deleteSubscription, listSubscriptions, type CreateSubscriptionInput } from "./service.ts";

interface SubscriptionParentParams {
  endpointId: string;
}

interface SubscriptionIdParams {
  endpointId: string;
  subscriptionId: string;
}

/**
 * Subscription routes are nested under their owning endpoint
 * (`/endpoints/:endpointId/subscriptions`) rather than exposed as a
 * top-level `/subscriptions` collection, since a subscription only ever
 * makes sense in the context of one endpoint.
 */
export function registerSubscriptionRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  app.post<{ Params: SubscriptionParentParams; Body: CreateSubscriptionInput }>(
    "/endpoints/:endpointId/subscriptions",
    {
      schema: {
        description:
          "Subscribes a webhook endpoint to an event type by name. 404 for an unknown endpoint, 400 for an unknown " +
          "event type, 409 if the endpoint already holds this subscription (enforced by a database uniqueness constraint).",
        tags: ["subscriptions"],
        params: subscriptionParentParamsSchema,
        body: createSubscriptionBodySchema,
        response: {
          201: subscriptionResponseSchema,
          400: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const subscription = await createSubscription(prisma, request.params.endpointId, request.body);
      reply.status(201);
      return subscription;
    },
  );

  app.get<{ Params: SubscriptionParentParams }>(
    "/endpoints/:endpointId/subscriptions",
    {
      schema: {
        description: "Lists the subscriptions for a webhook endpoint.",
        tags: ["subscriptions"],
        params: subscriptionParentParamsSchema,
        response: { 200: listSubscriptionsResponseSchema, 404: errorResponseSchema },
      },
    },
    async (request) => listSubscriptions(prisma, request.params.endpointId),
  );

  app.delete<{ Params: SubscriptionIdParams }>(
    "/endpoints/:endpointId/subscriptions/:subscriptionId",
    {
      schema: {
        description: "Removes a subscription.",
        tags: ["subscriptions"],
        params: subscriptionIdParamsSchema,
        response: { 204: { type: "null" }, 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      await deleteSubscription(prisma, request.params.endpointId, request.params.subscriptionId);
      reply.status(204);
    },
  );
}
