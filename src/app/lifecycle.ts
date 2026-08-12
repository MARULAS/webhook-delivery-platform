import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "../infrastructure/database/prisma.ts";
import type { AppConfig } from "./config.ts";
import { connectDatabase, disconnectDatabase } from "../infrastructure/database/prisma.ts";
import { createDeliveryWorker, type DeliveryWorker } from "../worker/delivery-worker.ts";

/**
 * Connects the database, starts listening, starts the delivery worker, logs
 * one structured startup line, and wires graceful shutdown. Does not decide
 * what happens on failure; the caller (src/index.ts) is responsible for
 * reporting a startup failure to stderr and exiting non-zero.
 */
export async function startApplication(
  app: FastifyInstance,
  prisma: PrismaClient,
  config: AppConfig,
): Promise<void> {
  await connectDatabase(prisma);
  await app.listen({ port: config.port, host: "0.0.0.0" });

  app.log.info({ port: config.port, nodeEnv: config.nodeEnv }, "Server started");

  // The API and the worker share this process but not their responsibilities:
  // the worker is started here, alongside the server, and is never reachable
  // from a route (ARCHITECTURE.md section 32).
  let worker: DeliveryWorker | null = null;
  if (config.workerEnabled) {
    worker = createDeliveryWorker(prisma, config, app.log);
    worker.start();
    app.log.info(
      {
        pollIntervalMs: config.workerPollIntervalMs,
        concurrency: config.workerConcurrency,
        batchSize: config.workerBatchSize,
        deliveryTimeoutMs: config.deliveryTimeoutMs,
        leaseMs: config.deliveryLeaseMs,
      },
      "Delivery worker started",
    );
  } else {
    app.log.warn("Delivery worker is disabled; deliveries will accumulate in PENDING");
  }

  registerShutdownHandlers(app, prisma, worker);
}

/**
 * Registers SIGINT/SIGTERM handlers exactly once each. On either signal: stop
 * claiming new deliveries, stop accepting new connections (Fastify close),
 * then disconnect Prisma. A second signal while shutdown is already in
 * progress is ignored rather than starting a second concurrent shutdown.
 *
 * Stopping the worker only halts further claims; it does not wait for an
 * in-flight delivery. Draining in-flight work is Part 5's concern, and the
 * system is designed not to need it: a delivery interrupted mid-flight keeps
 * its persisted lease and is recovered when that lease expires, so correctness
 * never depends on shutdown completing cleanly (ARCHITECTURE.md section 31).
 */
function registerShutdownHandlers(
  app: FastifyInstance,
  prisma: PrismaClient,
  worker: DeliveryWorker | null,
): void {
  let shuttingDown = false;

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    app.log.info({ signal }, "Shutting down");
    worker?.stop();

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
