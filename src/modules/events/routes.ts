import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "../../infrastructure/database/prisma.ts";
import { errorResponseSchema } from "../../shared/errors/error-schema.ts";
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
          "Publishes an event. Persists the event and one PENDING delivery per enabled, subscribed endpoint, in a single " +
          "transaction, then returns 201 without waiting for any outbound webhook (delivery happens asynchronously in the " +
          "background worker). The optional `Idempotency-Key` header protects against duplicate publication: replaying the " +
          "same key with the same `type` and `payload` returns the original event with 200 instead of creating a second " +
          "event and delivery set; reusing the same key for a materially different request returns 409. An unknown `type` " +
          "or a malformed `payload` returns 400. When the worker later delivers each resulting Delivery, the outbound " +
          "request carries `X-Webhook-Timestamp` (unix seconds) and `X-Webhook-Signature` (`sha256=<hex HMAC-SHA256>` over " +
          "`\"<timestamp>.\" + <raw body bytes>`, keyed by the target endpoint's signing secret) — see `POST /endpoints`.",
        tags: ["events"],
        headers: publishEventHeadersSchema,
        body: publishEventBodySchema,
        response: { 200: eventResponseSchema, 201: eventResponseSchema, 400: errorResponseSchema, 409: errorResponseSchema },
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
        response: { 200: eventResponseSchema, 404: errorResponseSchema },
      },
    },
    async (request) => getEvent(prisma, request.params.eventId),
  );
}
