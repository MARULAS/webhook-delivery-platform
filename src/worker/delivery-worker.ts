import type { AppConfig } from "../app/config.ts";
import type { PrismaClient } from "../infrastructure/database/prisma.ts";
import type { Logger } from "../infrastructure/logging/logger.ts";
import { claimPendingDeliveries } from "./delivery-claiming.ts";
import { executeDelivery } from "./delivery-execution.ts";
import { recoverExpiredLeases } from "./lease-recovery.ts";
import { runWithConcurrencyLimit } from "./concurrency.ts";

/**
 * The background delivery worker (ARCHITECTURE.md section 9).
 *
 * Each iteration recovers expired leases, claims a bounded batch, and runs it
 * through a bounded pool. The worker is the only thing in the system that
 * sends a webhook; the API never calls into it (ARCHITECTURE.md section 32).
 *
 * Recovery runs before the claim, and once per iteration, so a delivery
 * stranded by a crashed worker is returned to a processable state and picked up
 * by the very next claim rather than waiting a further poll interval. It is
 * bounded by the same batch size as the claim.
 *
 * Failure isolation is layered deliberately:
 *
 *  - one delivery's failure is caught per delivery, so the other deliveries in
 *    the same batch still run;
 *  - an iteration's failure (a claim against an unreachable database, say) is
 *    caught per iteration, so the loop keeps polling instead of dying.
 *
 * A delivery that fails at the persistence step stays in PROCESSING with its
 * lease still set, and the recovery sweep is what returns it to a processable
 * state once that lease expires. Nothing resets a delivery on the strength of
 * an in-process assumption.
 *
 * Scheduling uses a self-rescheduling `setTimeout` rather than `setInterval`,
 * so a slow iteration can never overlap the next one. Nothing about the work
 * itself lives in that timer — every pending delivery and every scheduled
 * retry is a row in PostgreSQL, so stopping the process loses no work
 * (ENGINEERING_RULES.md section 11).
 *
 * ## Shutdown
 *
 * `stop()` is immediate and synchronous: no further iteration is scheduled, an
 * iteration already past its timer makes no claim, and the pool stops starting
 * deliveries it has not begun. `drain()` then waits, for a bounded time, on whatever iteration was
 * already running. Rows that were claimed but never started, and requests still
 * in flight when the window closes, stay PROCESSING and are recovered by lease
 * expiry — correctness never depends on shutdown succeeding
 * (ARCHITECTURE.md section 31).
 */

export interface DeliveryWorker {
  /** Begins polling. Safe to call once; the timer does not hold the process open. */
  start(): void;
  /**
   * Stops scheduling iterations, claiming, and starting further deliveries.
   * Returns immediately; it does not abort an in-flight request.
   */
  stop(): void;
  /**
   * Waits for the iteration that was already running when `stop()` was called.
   * Resolves `true` if it finished within `timeoutMs`, `false` if the window
   * closed first. Never rejects, and never waits unbounded.
   */
  drain(timeoutMs: number): Promise<boolean>;
  /**
   * Runs exactly one recover-claim-and-deliver iteration and resolves with the
   * number of deliveries claimed. Tests drive the worker through this instead
   * of racing a background loop.
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
  /** The iteration currently running, or null between iterations. */
  let currentIteration: Promise<void> | null = null;

  async function runOnce(): Promise<number> {
    const sweep = await recoverExpiredLeases(prisma, {
      batchSize: config.workerBatchSize,
      maxDeliveryAttempts: config.maxDeliveryAttempts,
    });
    if (sweep.recovered > 0) {
      // Only logged when it actually did something: a sweep that finds nothing
      // is the normal case and would be pure noise several times a second.
      logger.warn(
        { recovered: sweep.recovered },
        "Recovered deliveries whose processing lease had expired",
      );
    }
    if (sweep.abandoned > 0) {
      logger.error(
        { abandoned: sweep.abandoned },
        "Abandoned deliveries that were claimed repeatedly without ever recording an outcome",
      );
    }

    // Claiming after `stop()` would flip a whole batch to PROCESSING with a
    // fresh lease and then start none of it, because the pool below is already
    // refusing to start work. Those rows would be unclaimable by anyone for a
    // full lease period after every clean shutdown, and `drain()` would report
    // success. The sweep above is safe to have run either way.
    if (stopped) {
      return 0;
    }

    const claimed = await claimPendingDeliveries(prisma, {
      batchSize: config.workerBatchSize,
      leaseMs: config.deliveryLeaseMs,
    });

    if (claimed.length === 0) {
      return 0;
    }

    await runWithConcurrencyLimit(
      claimed,
      config.workerConcurrency,
      async (delivery) => {
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
      },
      () => stopped,
    );

    return claimed.length;
  }

  function scheduleNext(delayMs: number): void {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      currentIteration = tick().finally(() => {
        currentIteration = null;
      });
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
    async drain(timeoutMs: number): Promise<boolean> {
      const iteration = currentIteration;
      if (iteration === null) {
        return true;
      }

      let deadline: NodeJS.Timeout | undefined;
      const expired = new Promise<boolean>((resolve) => {
        deadline = setTimeout(() => resolve(false), timeoutMs);
        // A drain that is waiting must not by itself keep the process alive.
        deadline.unref();
      });

      try {
        // `tick` handles its own errors, but settling on rejection too keeps a
        // shutdown from hanging on any future change to that.
        return await Promise.race([iteration.then(() => true, () => true), expired]);
      } finally {
        clearTimeout(deadline);
      }
    },
    runOnce,
  };
}
