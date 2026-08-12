import type { PrismaClient } from "../infrastructure/database/prisma.ts";

/**
 * Atomic delivery claiming — the project's one sanctioned use of raw SQL
 * (ARCHITECTURE.md section 10, ENGINEERING_RULES.md section 8).
 *
 * ## Why this cannot be Prisma
 *
 * Claiming must be a single statement that both selects eligible rows and
 * marks them PROCESSING. If it were a `findMany` followed by an `updateMany`,
 * two workers could read the same PENDING row before either wrote, and both
 * would deliver it — the receiver gets the same webhook twice from one
 * intended attempt. Prisma's query API exposes no way to express
 * `FOR UPDATE SKIP LOCKED`, which is precisely the primitive that makes the
 * select-and-lock atomic: PostgreSQL locks the rows this statement selects and
 * lets a concurrent claim skip straight past them instead of blocking on them.
 *
 * Every value is bound as a parameter through Prisma's tagged template; nothing
 * is interpolated into the SQL text. The rest of the persistence layer
 * continues to use Prisma normally.
 *
 * ## Details worth knowing
 *
 * - `updatedAt` is set explicitly. Prisma's `@updatedAt` is applied by the
 *   client, not by a database default, so a raw UPDATE that omitted this
 *   column would violate its NOT NULL constraint.
 * - Timestamps come from `now() AT TIME ZONE 'utc'`, not from the application
 *   clock. The columns are `timestamp without time zone` holding UTC (that is
 *   how Prisma writes them), and using the database clock means lease expiry is
 *   judged against a single clock rather than across a skewed application/
 *   database pair.
 * - `attemptCount` is incremented here, inside the statement that grants
 *   exclusive ownership, so the attempt number handed back can never be minted
 *   twice. Deriving it from `COUNT(*)` over DeliveryAttempt would be a race.
 *   Note what this column therefore is: a monotonic count of *claims* that
 *   mints attempt numbers, not a count of attempts. Every claim increments it,
 *   including one that never sends a request (a disabled endpoint or an unsafe
 *   URL) and one interrupted by a crash or a database failure before its
 *   attempt row is written. The resulting gaps in numbering are harmless —
 *   numbers only have to be unique and increasing — but Part 5's
 *   automatic-attempt budget must be counted from DeliveryAttempt rows rather
 *   than read from this column, or platform-side failures a receiver never saw
 *   would consume its retry budget.
 * - The batch is bounded by `batchSize`; there is no unbounded read of every
 *   eligible row.
 * - Eligibility is `PENDING` only. Part 5 extends it to due `RETRY_SCHEDULED`
 *   rows. Disabled endpoints are deliberately *not* filtered out here: an
 *   endpoint can be disabled at any moment after a claim, so the check that
 *   actually protects the receiver has to happen immediately before the
 *   request (see delivery-execution.ts). Repeating it here would add a join
 *   without changing any outcome, and would leave those deliveries stuck in
 *   PENDING forever instead of resolving them.
 * - The `("state", "createdAt")` index serves the inner select.
 */

export interface ClaimedDelivery {
  readonly id: string;
  /** Assigned by the claim itself; unique per delivery by construction. */
  readonly attemptNumber: number;
}

export interface ClaimOptions {
  readonly batchSize: number;
  readonly leaseMs: number;
}

interface ClaimRow {
  id: string;
  attemptCount: number;
}

export async function claimPendingDeliveries(
  prisma: PrismaClient,
  options: ClaimOptions,
): Promise<ClaimedDelivery[]> {
  const rows = await prisma.$queryRaw<ClaimRow[]>`
    UPDATE "Delivery" AS d
       SET "state" = 'PROCESSING',
           "claimedAt" = (now() AT TIME ZONE 'utc'),
           "leaseUntil" = (now() AT TIME ZONE 'utc') + (${options.leaseMs}::int * interval '1 millisecond'),
           "attemptCount" = d."attemptCount" + 1,
           "updatedAt" = (now() AT TIME ZONE 'utc')
      FROM (
             SELECT "id"
               FROM "Delivery"
              WHERE "state" = 'PENDING'
              ORDER BY "createdAt"
              LIMIT ${options.batchSize}::int
                FOR UPDATE SKIP LOCKED
           ) AS eligible
     WHERE d."id" = eligible."id"
    RETURNING d."id", d."attemptCount"
  `;

  return rows.map((row) => ({ id: row.id, attemptNumber: row.attemptCount }));
}
