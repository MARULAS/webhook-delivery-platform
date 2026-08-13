import type {
  DeliveryAttemptOutcome,
  DeliveryErrorCategory,
  DeliveryState,
} from "../../../generated/prisma/client.ts";
import type { PrismaClient } from "../../infrastructure/database/prisma.ts";
import {
  calculateNextAttemptAt,
  isRetryBudgetExhausted,
  type RetryPolicyConfig,
} from "../../worker/retry-policy.ts";

/**
 * Delivery state transitions (ARCHITECTURE.md section 16).
 *
 * The single home for moving a Delivery out of PROCESSING and for writing the
 * DeliveryAttempt that justifies the move. The worker calls these; nothing
 * reimplements the transition, and no route performs one.
 *
 * The retry policy is imported rather than inlined: it lives in src/worker/
 * where ARCHITECTURE.md section 5 puts it, and it is a pure function of its
 * arguments. The decision has to be made *here* because it depends on a count
 * that must be read inside the same transaction that writes the attempt row.
 *
 * ## Fencing: why the guard is `state = PROCESSING AND attemptCount = mine`
 *
 * A worker can finish an outbound request after its lease has expired — a long
 * garbage-collection pause, a stalled socket, a suspended process. By then the
 * recovery sweep may have returned the row to RETRY_SCHEDULED and another
 * worker may have claimed it. That row is PROCESSING again, so a guard on
 * `state = PROCESSING` alone would happily let the stale worker write its
 * outcome over the new owner's in-flight attempt: a delivered webhook recorded
 * as failed, or a retry cancelled by a result that predates it.
 *
 * `Delivery.attemptCount` fixes this without any new infrastructure. The claim
 * statement increments it inside the same statement that grants ownership
 * (src/worker/delivery-claiming.ts), so each value is minted exactly once and
 * never reused: the attempt number a worker was handed *is* its ownership
 * token. Guarding on `attemptCount = <my attempt number>` therefore means "I am
 * still the current owner", and a re-claim invalidates the previous holder's
 * token automatically. `updateMany` keeps the check inside the WHERE clause, so
 * PostgreSQL evaluates it against the committed row rather than application
 * code evaluating a value it read earlier.
 *
 * ## What a lost race does and does not suppress
 *
 * Losing the race suppresses the *state transition* only. In
 * `completeDeliveryWithAttempt` the DeliveryAttempt row is written
 * unconditionally and the transaction still commits, because a request really
 * did leave this process and attempt history is a record of what happened, not
 * of who owned the row. It cannot collide with the new owner's attempt:
 * `(deliveryId, attemptNumber)` is unique and the numbers were minted
 * separately. `failDeliveryWithoutAttempt` writes nothing, because no request
 * was made.
 *
 * A suppressed transition is expected, not exceptional, so it is reported as
 * `applied: false` rather than thrown; the caller logs it at warn with the
 * delivery id and attempt number, and it is never silently dropped.
 *
 * Consequence worth knowing: because a stale attempt row can be inserted after
 * a newer one, ordering attempts by `attemptedAt` and ordering them by
 * `attemptNumber` can disagree in that rare case. The invariant is only that
 * numbers are unique and increasing, and it holds.
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

export interface TransitionConfig extends RetryPolicyConfig {
  readonly maxDeliveryAttempts: number;
  readonly deliveryTransactionTimeoutMs: number;
  readonly databaseConnectionTimeoutMs: number;
}

export interface TransitionResult {
  /** False when the delivery changed hands before this worker finished. */
  readonly applied: boolean;
  /** The state written, or null when the transition was suppressed. */
  readonly state: DeliveryState | null;
}

/**
 * Records one outbound attempt and moves the delivery to the state that
 * attempt implies, in a single short transaction so an attempt can never be
 * persisted without the state change it caused, or the reverse. No HTTP
 * happens inside it — the request has already completed by the time this is
 * called (ENGINEERING_RULES.md section 9).
 *
 * Outcome routing (D3, IMPLEMENTATION_PLAN.md section 3):
 *
 *   SUCCESS             -> DELIVERED
 *   PERMANENT_FAILURE   -> FAILED immediately, whatever the budget says
 *   RETRYABLE_FAILURE   -> RETRY_SCHEDULED, or FAILED once the budget is spent
 */
export async function completeDeliveryWithAttempt(
  prisma: PrismaClient,
  deliveryId: string,
  attempt: DeliveryAttemptRecord,
  config: TransitionConfig,
): Promise<TransitionResult> {
  return prisma.$transaction(async (tx) => {
    // Unconditional: this row is history. See the fencing note above.
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

    // The budget is the number of requests that actually left the process,
    // counted from the attempt rows (including the one just written) rather
    // than read from Delivery.attemptCount. That column counts *claims*: a
    // claim that never sent anything — disabled endpoint, unsafe URL, a crash
    // before the attempt was written — still increments it, and letting a
    // platform-side failure burn a receiver's retry budget would be wrong.
    // Under READ COMMITTED this count cannot see an uncommitted attempt row
    // from a stale worker running concurrently, so the budget can overshoot by
    // at most one attempt per recovery event. That is bounded, consistent with
    // the at-least-once guarantee the platform already makes, and deliberately
    // not defended against: serializing the two would cost a heavier isolation
    // level or a lock on every completion to save one extra retry.
    const attemptsMade = await tx.deliveryAttempt.count({ where: { deliveryId } });

    // The retry due time is written on the *database's* clock, because the
    // claim decides whether a retry is due on the database's clock
    // (`nextAttemptAt <= now()` in src/worker/delivery-claiming.ts). Writing it
    // on the application's clock instead would make backoff depend on the skew
    // between two hosts: an application clock running behind the database by
    // more than the delay would emit due times that are already past, and the
    // backoff would collapse to poll speed against an already-failing receiver.
    //
    // `clock_timestamp()`, not `now()`: `now()` is transaction *start* time, so
    // a transaction that waited on a row lock would silently shorten the delay
    // it then writes. Epoch milliseconds rather than a timestamp keeps the
    // value free of any timezone interpretation on the way back.
    //
    // This is a clock read, not a data-access query — the claim and the
    // recovery sweep remain the only raw statements that touch domain rows.
    const clock = await tx.$queryRaw<{ nowMs: bigint }[]>`
      SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS "nowMs"
    `;
    const now = new Date(Number(clock[0]!.nowMs));

    const next = decideNextState(attempt, attemptsMade, now, config);

    // updateMany, not update: both guards live in the WHERE clause, so
    // PostgreSQL decides whether this transition is still legal.
    const updated = await tx.delivery.updateMany({
      where: { id: deliveryId, state: "PROCESSING", attemptCount: attempt.attemptNumber },
      data: {
        state: next.state,
        completedAt: next.completedAt,
        nextAttemptAt: next.nextAttemptAt,
        failureReason: next.failureReason,
      },
    });

    if (updated.count !== 1) {
      // The transaction still commits, keeping the attempt row.
      return { applied: false, state: null };
    }

    return { applied: true, state: next.state };
  }, {
    // Bounded on purpose. An unbounded transaction — blocked on a row lock, or
    // waiting on a saturated connection pool — would keep the delivery live
    // past its processing lease and let the recovery sweep hand it to another
    // worker, sending the receiver the same webhook twice. Both bounds come
    // from the lease derivation's per-delivery allowance (src/app/config.ts).
    timeout: config.deliveryTransactionTimeoutMs,
    maxWait: config.databaseConnectionTimeoutMs,
  });
}

interface NextState {
  readonly state: DeliveryState;
  readonly completedAt: Date | null;
  readonly nextAttemptAt: Date | null;
  readonly failureReason: string | null;
}

/**
 * `attempt.errorMessage` is platform-generated text (see
 * src/worker/delivery-execution.ts) and is safe to persist; no receiver
 * response body and no secret ever reaches it.
 */
function decideNextState(
  attempt: DeliveryAttemptRecord,
  attemptsMade: number,
  now: Date,
  retry: TransitionConfig,
): NextState {
  if (attempt.outcome === "SUCCESS") {
    return { state: "DELIVERED", completedAt: now, nextAttemptAt: null, failureReason: null };
  }

  const retryable = attempt.outcome === "RETRYABLE_FAILURE";

  if (retryable && !isRetryBudgetExhausted(attemptsMade, retry.maxDeliveryAttempts)) {
    return {
      state: "RETRY_SCHEDULED",
      // Not terminal, so no completion timestamp and no failure reason: the
      // failure that caused the retry is recorded on the attempt row.
      completedAt: null,
      nextAttemptAt: calculateNextAttemptAt(attemptsMade, now, retry),
      failureReason: null,
    };
  }

  // Either a PERMANENT_FAILURE — D3 sends those straight to FAILED, and they
  // consume no budget because no retry is ever scheduled against them — or the
  // last attempt the budget allowed.
  const failureReason = retryable
    ? `Delivery failed after ${attemptsMade} automatic attempts. Last failure: ${attempt.errorMessage ?? "no detail recorded"}`
    : attempt.errorMessage;

  return { state: "FAILED", completedAt: now, nextAttemptAt: null, failureReason };
}

/**
 * Fails a delivery that was claimed but for which no request was ever sent —
 * the endpoint was disabled, or its URL is no longer a permitted destination.
 *
 * No DeliveryAttempt is written, because no attempt was made: an attempt row
 * means "a request left this process". Nothing here consumes retry budget, and
 * both causes are terminal, so there is no retry branch. `reason` is a fixed
 * platform string containing no secret.
 *
 * Fenced on the same ownership token as the transition above. A zero-row
 * result means the delivery changed hands, which is a legitimate outcome and
 * not an error; the caller logs it.
 */
export async function failDeliveryWithoutAttempt(
  prisma: PrismaClient,
  deliveryId: string,
  attemptNumber: number,
  reason: string,
): Promise<TransitionResult> {
  const updated = await prisma.delivery.updateMany({
    where: { id: deliveryId, state: "PROCESSING", attemptCount: attemptNumber },
    data: {
      state: "FAILED",
      completedAt: new Date(),
      nextAttemptAt: null,
      failureReason: reason,
    },
  });

  return updated.count === 1
    ? { applied: true, state: "FAILED" }
    : { applied: false, state: null };
}
