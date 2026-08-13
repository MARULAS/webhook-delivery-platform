import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "../../infrastructure/database/prisma.ts";
import { metricsResponseSchema } from "./schemas.ts";
import { getMetrics } from "./service.ts";

export function registerMetricsRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  app.get(
    "/metrics",
    {
      schema: {
        description:
          "Basic operational metrics computed from persisted rows: events accepted, deliveries by outcome, success rate, and average delivery duration.",
        tags: ["metrics"],
        response: { 200: metricsResponseSchema },
      },
    },
    async () => getMetrics(prisma),
  );
}
