import type {
  DeliveryAttemptOutcome,
  DeliveryErrorCategory,
  DeliveryState,
} from "../../../generated/prisma/client.ts";
import type { PrismaClient } from "../../infrastructure/database/prisma.ts";
import { InvalidStateError } from "../../shared/errors/app-error.ts";

/**
 * Delivery state transitions (ARCHITECTURE.md section 16).
 *
 * The single home for moving a Delivery out of PROCESSING and for writing the
 * DeliveryAttempt that justifies the move. The worker calls these; nothing
 * reimplements the transition, and no route performs one.
 *
 * Part 4 implements PROCESSING -> DELIVERED and PROCESSING -> FAILED. Part 5
 * adds PROCESSING -> RETRY_SCHEDULED and changes only which of these a
 * retryable failure takes; the attempt-writing behavior here is unaffected.
 *
 * Every transition is guarded on the delivery still being PROCESSING. In this
 * part the worker holds an unexpired lease whenever it calls these, so the
 * guard should never fire; it exists because Part 5 introduces lease recovery,
 * after which a delivery can legitimately change hands, and a lost race must
 * fail loudly rather than silently overwrite another worker's outcome.
 */

export interface DeliveryAttemptRecord {
  readonly attemptNumber: number;
  readonly attemptedAt: Date;
  readonly outcome: DeliveryAttemptOutcome;
  readonly httpStatusCode: number | null;
  readonly durationMs: number;
  readonly errorCategory: DeliveryErrorCategory | null;
  /** Platform-generated and safe to persist; never a receiver response body. */
  readonly errorMessage: string | null;
}

/**
 * Records one outbound attempt and moves the delivery to its resulting
 * terminal state, in a single short transaction so an attempt can never be
 * persisted without the state change it caused, or the reverse. No HTTP
 * happens inside it — the request has already completed by the time this is
 * called (ENGINEERING_RULES.md section 9).
 */
export async function completeDeliveryWithAttempt(
  prisma: PrismaClient,
  deliveryId: string,
  attempt: DeliveryAttemptRecord,
): Promise<DeliveryState> {
  // D3 (IMPLEMENTATION_PLAN.md section 3): in Part 4 every non-success ends in
  // FAILED. Part 5 routes RETRYABLE_FAILURE to RETRY_SCHEDULED instead, which
  // is why the outcome distinction is already recorded on the attempt.
  const state: DeliveryState = attempt.outcome === "SUCCESS" ? "DELIVERED" : "FAILED";
  const completedAt = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.deliveryAttempt.create({
      data: {
        deliveryId,
        attemptNumber: attempt.attemptNumber,
        attemptedAt: attempt.attemptedAt,
        outcome: attempt.outcome,
        httpStatusCode: attempt.httpStatusCode,
        durationMs: attempt.durationMs,
        errorCategory: attempt.errorCategory,
        errorMessage: attempt.errorMessage,
      },
    });

    // updateMany, not update: the state guard is part of the WHERE clause, so
    // PostgreSQL decides whether this transition is legal rather than a
    // read-then-write in application code that two workers could both pass.
    const updated = await tx.delivery.updateMany({
      where: { id: deliveryId, state: "PROCESSING" },
      data: {
        state,
        completedAt,
        failureReason: state === "FAILED" ? attempt.errorMessage : null,
      },
    });

    if (updated.count !== 1) {
      throw new InvalidStateError("Delivery was no longer PROCESSING when its attempt completed.");
    }
  });

  return state;
}

/**
 * Fails a delivery that was claimed but for which no request was ever sent —
 * the endpoint was disabled, or its URL is no longer a permitted destination.
 *
 * No DeliveryAttempt is written, because no attempt was made: an attempt row
 * means "a request left this process". `reason` is a fixed platform string
 * containing no secret.
 */
export async function failDeliveryWithoutAttempt(
  prisma: PrismaClient,
  deliveryId: string,
  reason: string,
): Promise<void> {
  const updated = await prisma.delivery.updateMany({
    where: { id: deliveryId, state: "PROCESSING" },
    data: { state: "FAILED", completedAt: new Date(), failureReason: reason },
  });

  if (updated.count !== 1) {
    throw new InvalidStateError("Delivery was no longer PROCESSING when it was abandoned.");
  }
}
