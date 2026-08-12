import type { AppConfig } from "../app/config.ts";
import type { PrismaClient } from "../infrastructure/database/prisma.ts";
import type { Logger } from "../infrastructure/logging/logger.ts";
import { claimPendingDeliveries } from "./delivery-claiming.ts";
import { executeDelivery } from "./delivery-execution.ts";
import { runWithConcurrencyLimit } from "./concurrency.ts";

/**
 * The background delivery worker (ARCHITECTURE.md section 9).
 *
 * Each iteration claims a bounded batch and runs it through a bounded pool.
 * The worker is the only thing in the system that sends a webhook; the API
 * never calls into it (ARCHITECTURE.md section 32).
 *
 * Failure isolation is layered deliberately:
 *
 *  - one delivery's failure is caught per delivery, so the other deliveries in
 *    the same batch still run;
 *  - an iteration's failure (a claim against an unreachable database, say) is
 *    caught per iteration, so the loop keeps polling instead of dying.
 *
 * A delivery that fails at the persistence step stays in PROCESSING with its
 * lease still set. That is the intended outcome for now: Part 5's lease
 * recovery is what returns such a row to a processable state. Part 4
 * deliberately does not sweep, so no delivery is silently reset here.
 *
 * Scheduling uses a self-rescheduling `setTimeout` rather than `setInterval`,
 * so a slow iteration can never overlap the next one. Nothing about the work
 * itself lives in that timer — every pending delivery is a row in PostgreSQL,
 * so stopping the process loses no work (ENGINEERING_RULES.md section 11).
 */

export interface DeliveryWorker {
  /** Begins polling. Safe to call once; the timer does not hold the process open. */
  start(): void;
  /** Stops scheduling further iterations. Does not abort an in-flight one. */
  stop(): void;
  /**
   * Runs exactly one claim-and-deliver iteration and resolves with the number
   * of deliveries claimed. Tests drive the worker through this instead of
   * racing a background loop.
   */
  runOnce(): Promise<number>;
}

export function createDeliveryWorker(
  prisma: PrismaClient,
  config: AppConfig,
  logger: Logger,
): DeliveryWorker {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  async function runOnce(): Promise<number> {
    const claimed = await claimPendingDeliveries(prisma, {
      batchSize: config.workerBatchSize,
      leaseMs: config.deliveryLeaseMs,
    });

    if (claimed.length === 0) {
      return 0;
    }

    await runWithConcurrencyLimit(claimed, config.workerConcurrency, async (delivery) => {
      try {
        await executeDelivery({ prisma, config, logger }, delivery);
      } catch (err) {
        // Receiver failures never reach here — they are recorded as attempts.
        // This is an unexpected platform-side failure, so it is logged with
        // context and contained rather than swallowed or allowed to abort the
        // rest of the batch.
        logger.error(
          { err, deliveryId: delivery.id, attemptNumber: delivery.attemptNumber },
          "Delivery processing failed unexpectedly",
        );
      }
    });

    return claimed.length;
  }

  function scheduleNext(delayMs: number): void {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      void tick();
    }, delayMs);
    // The worker must not be the reason the process stays alive.
    timer.unref();
  }

  async function tick(): Promise<void> {
    try {
      const claimedCount = await runOnce();
      // Poll again immediately while work is still arriving, so a backlog
      // drains at the speed of the pool rather than of the poll interval.
      scheduleNext(claimedCount > 0 ? 0 : config.workerPollIntervalMs);
    } catch (err) {
      logger.error({ err }, "Delivery worker iteration failed");
      scheduleNext(config.workerPollIntervalMs);
    }
  }

  return {
    start(): void {
      scheduleNext(0);
    },
    stop(): void {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
    runOnce,
  };
}
