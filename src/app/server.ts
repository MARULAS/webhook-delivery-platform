import Fastify, { type FastifyInstance } from "fastify";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import type { AppConfig } from "./config.ts";
import { buildLoggerOptions } from "../infrastructure/logging/logger.ts";
import { registerErrorHandling } from "../shared/errors/error-handler.ts";
import { registerHealthRoute } from "./health-route.ts";
import type { PrismaClient } from "../infrastructure/database/prisma.ts";
import { registerEndpointRoutes } from "../modules/endpoints/routes.ts";
import { registerSubscriptionRoutes } from "../modules/subscriptions/routes.ts";
import { registerEventRoutes } from "../modules/events/routes.ts";
import { registerDeliveryRoutes } from "../modules/deliveries/routes.ts";
import { registerMetricsRoutes } from "../modules/metrics/routes.ts";

/**
 * Builds the Fastify instance: logging, OpenAPI documentation, the shared
 * error handling, and the routes that exist so far. Does not call `listen`;
 * that belongs to lifecycle.ts so the instance stays usable in tests without
 * binding a port.
 */
export async function buildServer(config: AppConfig, prisma: PrismaClient): Promise<FastifyInstance> {
  const app = Fastify({
    logger: buildLoggerOptions(config),
  });

  await app.register(fastifySwagger, {
    openapi: {
      openapi: "3.0.0",
      info: {
        title: "Webhook Delivery Platform API",
        description: "Reliable webhook event delivery with retries, idempotency, and HMAC signing.",
        version: "0.1.0",
      },
      tags: [
        { name: "health", description: "Operational health checks" },
        { name: "endpoints", description: "Webhook endpoint management" },
        { name: "subscriptions", description: "Endpoint-to-event-type subscriptions" },
        { name: "events", description: "Event publication and lookup" },
        {
          name: "deliveries",
          description: "Delivery records, attempt history, filtering, and manual retry",
        },
        { name: "metrics", description: "Basic operational metrics" },
      ],
    },
  });

  await app.register(fastifySwaggerUi, {
    routePrefix: "/docs",
  });

  registerErrorHandling(app);
  registerHealthRoute(app, prisma);
  registerEndpointRoutes(app, prisma, config);
  registerSubscriptionRoutes(app, prisma);
  registerEventRoutes(app, prisma);
  registerDeliveryRoutes(app, prisma);
  registerMetricsRoutes(app, prisma);

  return app;
}
