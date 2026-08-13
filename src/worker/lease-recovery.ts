import type { PrismaClient } from "../infrastructure/database/prisma.ts";

/**
 * Lease recovery (ARCHITECTURE.md section 11, SPEC.md section 16).
 *
 * A worker that dies mid-delivery — a crash, a container kill, a shutdown that
 * ran out of grace time — leaves its rows in PROCESSING with a lease that
 * nobody will ever release. This sweep is what guarantees that no delivery
 * stays in PROCESSING indefinitely: once the lease has expired, the row goes
 * back to RETRY_SCHEDULED and becomes claimable again.
 *
 * ## Why raw SQL, again
 *
 * Same reason as the claim (src/worker/delivery-claiming.ts), and this is the
 * project's second and last raw statement. Select-then-update in application
 * code would let two workers sweep the same row, and — worse — would let a
 * sweep and a concurrent claim both take one. `FOR UPDATE SKIP LOCKED` over a
 * bounded inner select makes recovery and claiming contend on the same row
 * locks, so exactly one of them can ever have a given row. Every value is
 * bound as a parameter; `updatedAt` is set explicitly because Prisma applies
 * `@updatedAt` client-side and the column has no database default; timestamps
 * come from the database clock so lease expiry is judged against one clock.
 *
 * ## What recovery deliberately does not do
 *
 * It does not touch `attemptCount`, and it does not delete or alter a single
 * DeliveryAttempt. History is preserved, and because the automatic-attempt
 * budget is a count of those rows, the attempts made before the crash still
 * count against it. Note the limit of that statement: an interruption that
 * happened *before* the request left the process legitimately costs no budget,
 * but an interruption *after* it did means the receiver saw a request that was
 * never recorded — which is exactly the loop the claim ceiling below bounds.
 *
 * A live lease is what makes a row unrecoverable: a delivery a live worker
 * still holds has a lease in the future and is not selected. The lease is
 * derived to be strictly longer than the delivery timeout plus the bounded
 * per-delivery database work (`deriveDeliveryLeaseMs` in src/app/config.ts), so
 * a slow-but-live delivery is not reclaimed. If one ever were, the fencing
 * token on the state transitions stops the stale worker from overwriting the
 * new owner's outcome. A NULL `leaseUntil` counts as expired: no code path
 * produces one, but treating it as unrecoverable would leave such a row in
 * PROCESSING forever, which is precisely what this module exists to prevent.
 *
 * ## Recovered rows are due immediately
 *
 * `nextAttemptAt` is set to now rather than to a backoff delay, so a stranded
 * delivery resumes promptly instead of being punished for the platform's
 * failure. This cannot become a hot loop: a row only becomes recoverable after
 * a whole lease has expired, and the lease is long relative to the delivery
 * timeout, so a repeatedly-stranded delivery retries at most once per lease
 * period.
 *
 * ## The claim ceiling
 *
 * Recovery on its own is not a bounded process. Consider a delivery whose
 * request reaches the receiver but whose completion transaction then fails:
 * no attempt row is committed, so the budget — a count of attempt rows — is
 * untouched, the row stays PROCESSING, the lease expires, the sweep recovers
 * it, and it is sent again. `MAX_DELIVERY_ATTEMPTS` never applies, because it
 * is only ever evaluated inside the transaction that keeps failing. Under
 * sustained database trouble that is unbounded duplicate delivery with no
 * terminal state.
 *
 * `Delivery.attemptCount` is the bound, because it is incremented by the claim
 * itself and therefore survives exactly the failures the attempt row does not.
 * A delivery claimed far more often than its budget could ever justify is
 * stuck, not retrying, so the sweep ends it in FAILED instead of returning it
 * to the queue. The allowance is deliberately generous — normal crash recovery
 * never approaches it.
 */

/**
 * How many claims beyond the attempt budget a delivery may accumulate before
 * the sweep treats it as stuck. Every one of these represents a claim that
 * produced no recorded outcome at all, so reaching the ceiling means the
 * platform failed to persist an outcome this many times in a row for one
 * delivery, each time separated by a full lease period.
 *
 * (Part 6's manual retry resets the automatic-attempt budget and will need to
 * account for this counter, which only ever increases.)
 */
const STUCK_DELIVERY_CLAIM_ALLOWANCE = 10;

/** The claim count at or above which a stranded delivery is abandoned. */
export function stuckDeliveryClaimCeiling(maxDeliveryAttempts: number): number {
  return maxDeliveryAttempts + STUCK_DELIVERY_CLAIM_ALLOWANCE;
}

const ABANDONED_REASON =
  "Delivery was interrupted repeatedly without recording an outcome and has been abandoned.";

export interface RecoveryOptions {
  /** Upper bound on rows touched per sweep; the worker passes its batch size. */
  readonly batchSize: number;
  readonly maxDeliveryAttempts: number;
}

export interface RecoveryResult {
  /** Returned to RETRY_SCHEDULED and immediately eligible again. */
  readonly recovered: number;
  /** Ended in FAILED because the claim ceiling was reached. */
  readonly abandoned: number;
}

interface SweptRow {
  id: string;
}

/**
 * Two statements rather than one with four `CASE` expressions: the outcomes
 * are disjoint (`attemptCount` is either at the ceiling or below it) and each
 * statement stays as readable as the claim it mirrors.
 */
export async function recoverExpiredLeases(
  prisma: PrismaClient,
  options: RecoveryOptions,
): Promise<RecoveryResult> {
  const ceiling = stuckDeliveryClaimCeiling(options.maxDeliveryAttempts);

  const abandoned = await prisma.$queryRaw<SweptRow[]>`
    UPDATE "Delivery" AS d
       SET "state" = 'FAILED',
           "completedAt" = (now() AT TIME ZONE 'utc'),
           "failureReason" = ${ABANDONED_REASON},
           "nextAttemptAt" = NULL,
           "updatedAt" = (now() AT TIME ZONE 'utc')
      FROM (
             SELECT "id"
               FROM "Delivery"
              WHERE "state" = 'PROCESSING'
                AND ("leaseUntil" < (now() AT TIME ZONE 'utc') OR "leaseUntil" IS NULL)
                AND "attemptCount" >= ${ceiling}::int
              ORDER BY "leaseUntil"
              LIMIT ${options.batchSize}::int
                FOR UPDATE SKIP LOCKED
           ) AS stuck
     WHERE d."id" = stuck."id"
    RETURNING d."id"
  `;

  // `date_trunc` on the due time, and only on the due time. The column is
  // `timestamp(3)`, and PostgreSQL *rounds* when it stores a microsecond value
  // into it — so a plain `now()` is written back as an instant up to half a
  // millisecond in the future, and the claim that immediately follows this
  // sweep finds `nextAttemptAt <= now()` false and skips the row it was just
  // handed. Truncating makes "recovered rows are due immediately" true rather
  // than true-most-of-the-time. The other timestamps here do not need it:
  // rounding a lease or a completion timestamp up by a fraction of a
  // millisecond changes no decision.
  const recovered = await prisma.$queryRaw<SweptRow[]>`
    UPDATE "Delivery" AS d
       SET "state" = 'RETRY_SCHEDULED',
           "nextAttemptAt" = date_trunc('milliseconds', now() AT TIME ZONE 'utc'),
           "updatedAt" = (now() AT TIME ZONE 'utc')
      FROM (
             SELECT "id"
               FROM "Delivery"
              WHERE "state" = 'PROCESSING'
                AND ("leaseUntil" < (now() AT TIME ZONE 'utc') OR "leaseUntil" IS NULL)
                AND "attemptCount" < ${ceiling}::int
              ORDER BY "leaseUntil"
              LIMIT ${options.batchSize}::int
                FOR UPDATE SKIP LOCKED
           ) AS expired
     WHERE d."id" = expired."id"
    RETURNING d."id"
  `;

  return { recovered: recovered.length, abandoned: abandoned.length };
}
