import type { FastifyInstance } from "fastify";
import { checkDatabase, type PrismaClient } from "../infrastructure/database/prisma.ts";

const healthResponseSchema = {
  200: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["ok"] },
      database: { type: "string", enum: ["up"] },
    },
    required: ["status", "database"],
  },
  503: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["degraded"] },
      database: { type: "string", enum: ["down"] },
    },
    required: ["status", "database"],
  },
} as const;

export function registerHealthRoute(app: FastifyInstance, prisma: PrismaClient): void {
  app.get(
    "/health",
    {
      schema: {
        description: "Reports application liveness and database reachability.",
        tags: ["health"],
        response: healthResponseSchema,
      },
    },
    async (_request, reply) => {
      const databaseUp = await checkDatabase(prisma);
      if (!databaseUp) {
        reply.status(503);
        return { status: "degraded" as const, database: "down" as const };
      }
      return { status: "ok" as const, database: "up" as const };
    },
  );
}
