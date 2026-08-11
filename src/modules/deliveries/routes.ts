import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "../../infrastructure/database/prisma.ts";
import { eventIdParamsSchema } from "../events/schemas.ts";
import { listDeliveriesResponseSchema } from "./schemas.ts";
import { listDeliveriesForEvent } from "./service.ts";

interface EventIdParams {
  eventId: string;
}

/**
 * A delivery is always reached through the event that produced it, so the
 * route is nested under `/events/:eventId` — the same shape as subscriptions
 * under their endpoint. Delivery history with filters is a later part.
 */
export function registerDeliveryRoutes(app: FastifyInstance, prisma: PrismaClient): void {
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
}
