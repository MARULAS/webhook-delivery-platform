import type { FastifyInstance } from "fastify";
import type { DeliveryState } from "../../../generated/prisma/client.ts";
import type { PrismaClient } from "../../infrastructure/database/prisma.ts";
import { eventIdParamsSchema } from "../events/schemas.ts";
import {
  deliveryIdParamsSchema,
  deliveryResponseSchema,
  listDeliveriesQuerySchema,
  listDeliveriesResponseSchema,
  listDeliveryAttemptsResponseSchema,
} from "./schemas.ts";
import {
  getDelivery,
  listDeliveries,
  listDeliveriesForEvent,
  listDeliveryAttempts,
  retryDelivery,
} from "./service.ts";

interface EventIdParams {
  eventId: string;
}

interface DeliveryIdParams {
  deliveryId: string;
}

interface ListDeliveriesQuery {
  status?: DeliveryState;
  endpointId?: string;
  eventId?: string;
  limit: number;
  offset: number;
}

export function registerDeliveryRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  // A delivery is always reached through the event that produced it, so this
  // route is nested under /events/:eventId — the same shape as subscriptions
  // under their endpoint.
  app.get<{ Params: EventIdParams }>(
    "/events/:eventId/deliveries",
    {
      schema: {
        description: "Lists the deliveries created for an event, one per enabled subscribed endpoint.",
        tags: ["deliveries"],
        params: eventIdParamsSchema,
        response: { 200: listDeliveriesResponseSchema },
      },
    },
    async (request) => listDeliveriesForEvent(prisma, request.params.eventId),
  );

  app.get<{ Querystring: ListDeliveriesQuery }>(
    "/deliveries",
    {
      schema: {
        description:
          "Lists deliveries, optionally filtered by status, endpoint, or event, with bounded limit/offset pagination.",
        tags: ["deliveries"],
        querystring: listDeliveriesQuerySchema,
        response: { 200: listDeliveriesResponseSchema },
      },
    },
    async (request) => {
      const { status, endpointId, eventId, limit, offset } = request.query;
      return listDeliveries(prisma, { status, endpointId, eventId, limit, offset });
    },
  );

  app.get<{ Params: DeliveryIdParams }>(
    "/deliveries/:deliveryId",
    {
      schema: {
        description: "Fetches a single delivery by id.",
        tags: ["deliveries"],
        params: deliveryIdParamsSchema,
        response: { 200: deliveryResponseSchema },
      },
    },
    async (request) => getDelivery(prisma, request.params.deliveryId),
  );

  app.get<{ Params: DeliveryIdParams }>(
    "/deliveries/:deliveryId/attempts",
    {
      schema: {
        description:
          "Lists a delivery's attempt history — outcome, HTTP status, timestamp, duration, and error category — ordered oldest first.",
        tags: ["deliveries"],
        params: deliveryIdParamsSchema,
        response: { 200: listDeliveryAttemptsResponseSchema },
      },
    },
    async (request) => listDeliveryAttempts(prisma, request.params.deliveryId),
  );

  app.post<{ Params: DeliveryIdParams }>(
    "/deliveries/:deliveryId/retry",
    {
      schema: {
        description:
          "Manually retries a FAILED delivery: returns it to PENDING, resets the automatic-attempt budget, and preserves all prior attempt history. Legal only from FAILED; 409 otherwise, 404 for an unknown delivery.",
        tags: ["deliveries"],
        params: deliveryIdParamsSchema,
        response: { 200: deliveryResponseSchema },
      },
    },
    async (request) => retryDelivery(prisma, request.params.deliveryId),
  );
}
