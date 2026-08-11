import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "../infrastructure/database/prisma.ts";
import type { AppConfig } from "./config.ts";
import { connectDatabase, disconnectDatabase } from "../infrastructure/database/prisma.ts";

/**
 * Connects the database, starts listening, logs one structured startup
 * line, and wires graceful shutdown. Does not decide what happens on
 * failure; the caller (src/index.ts) is responsible for reporting a startup
 * failure to stderr and exiting non-zero.
 */
export async function startApplication(
  app: FastifyInstance,
  prisma: PrismaClient,
  config: AppConfig,
): Promise<void> {
  await connectDatabase(prisma);
  await app.listen({ port: config.port, host: "0.0.0.0" });

  app.log.info({ port: config.port, nodeEnv: config.nodeEnv }, "Server started");

  registerShutdownHandlers(app, prisma);
}

/**
 * Registers SIGINT/SIGTERM handlers exactly once each. On either signal:
 * stop accepting new connections (Fastify close), then disconnect Prisma.
 * A second signal while shutdown is already in progress is ignored rather
 * than starting a second concurrent shutdown.
 */
function registerShutdownHandlers(app: FastifyInstance, prisma: PrismaClient): void {
  let shuttingDown = false;

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    app.log.info({ signal }, "Shutting down");

    app
      .close()
      .then(() => disconnectDatabase(prisma))
      .then(() => {
        process.exit(0);
      })
      .catch((err: unknown) => {
        app.log.error({ err }, "Error during shutdown");
        process.exit(1);
      });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
