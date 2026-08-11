import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "../../infrastructure/database/prisma.ts";
import { eventIdParamsSchema, eventResponseSchema, publishEventBodySchema, publishEventHeadersSchema } from "./schemas.ts";
import { getEvent, publishEvent, type PublishEventInput } from "./service.ts";

interface EventIdParams {
  eventId: string;
}

interface PublishEventHeaders {
  "idempotency-key"?: string;
}

export function registerEventRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  app.post<{ Body: PublishEventInput; Headers: PublishEventHeaders }>(
    "/events",
    {
      schema: {
        description:
          "Publishes an event. Persists the event and one PENDING delivery per enabled, subscribed endpoint, then returns without waiting for any outbound webhook. Replaying an `Idempotency-Key` with the same request returns the original event with 200; reusing it for a different request returns 409.",
        tags: ["events"],
        headers: publishEventHeadersSchema,
        body: publishEventBodySchema,
        response: { 200: eventResponseSchema, 201: eventResponseSchema },
      },
    },
    async (request, reply) => {
      const result = await publishEvent(prisma, request.body, request.headers["idempotency-key"]);
      reply.status(result.created ? 201 : 200);
      return result.event;
    },
  );

  app.get<{ Params: EventIdParams }>(
    "/events/:eventId",
    {
      schema: {
        description: "Fetches a published event by id.",
        tags: ["events"],
        params: eventIdParamsSchema,
        response: { 200: eventResponseSchema },
      },
    },
    async (request) => getEvent(prisma, request.params.eventId),
  );
}
