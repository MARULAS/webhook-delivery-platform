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
 *   numbers only have to be unique and increasing — but the automatic-attempt
 *   budget is counted from DeliveryAttempt rows rather than read from this
 *   column, or platform-side failures a receiver never saw would consume its
 *   retry budget. It is also the fencing token that lets a
 *   worker prove it still owns the row when it finishes
 *   (src/modules/deliveries/state-transitions.ts).
 * - The batch is bounded by `batchSize`; there is no unbounded read of every
 *   eligible row.
 * - Disabled endpoints are deliberately *not* filtered out here: an endpoint
 *   can be disabled at any moment after a claim, so the check that actually
 *   protects the receiver has to happen immediately before the request (see
 *   delivery-execution.ts). Repeating it here would add a join without
 *   changing any outcome, and would leave those deliveries stuck instead of
 *   resolving them.
 *
 * ## Eligibility
 *
 * A row is eligible when it is `PENDING`, or when it is `RETRY_SCHEDULED` and
 * its `nextAttemptAt` has arrived. That comparison is made against the database
 * clock for the same reason the lease is: one clock decides, not a possibly
 * skewed application/database pair.
 *
 * The boundary is `<=`, not `<`. `nextAttemptAt` is the instant the delivery
 * becomes due, so a row due exactly now is due; `<` would leave it eligible
 * only from the next microsecond onwards, which is the same behavior in
 * practice but makes "due at T" mean "due after T" — and a test that writes an
 * exact due time would then depend on clock granularity to pass.
 *
 * Ordering is `COALESCE("nextAttemptAt", "createdAt")`: for a scheduled retry
 * the due time is the fair position, and for a `PENDING` row — which has no
 * `nextAttemptAt` — its creation time is. Ordering by `createdAt` alone would
 * let a delivery created long ago and retried many times keep preceding fresh
 * work forever, and ordering by `nextAttemptAt` alone would sort every
 * `PENDING` row into one NULL group.
 *
 * Both arms of the OR are index-served: PostgreSQL bitmap-scans each one
 * through a `state`-leading index — `("state", "nextAttemptAt")` in particular
 * turns "due retries" into a range scan rather than a filter over every
 * scheduled retry — and combines them, so neither arm degrades into a
 * sequential scan of a table that only grows.
 *
 * The sort itself is not index-served: `COALESCE` over two columns matches no
 * index, so PostgreSQL top-N sorts every eligible row before applying the
 * `LIMIT`. The input to that sort is the backlog, not the batch, so a large
 * backlog is sorted on every poll. That is accepted at this system's scale;
 * changing the ordering to something an index can serve would trade fairness
 * between fresh work and due retries for a cost that is not yet real.
 *
 * `nextAttemptAt` is cleared by the claim, so it is null on any row that is not
 * currently waiting for a retry rather than lingering as a stale due time.
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
           "nextAttemptAt" = NULL,
           "attemptCount" = d."attemptCount" + 1,
           "updatedAt" = (now() AT TIME ZONE 'utc')
      FROM (
             SELECT "id"
               FROM "Delivery"
              WHERE "state" = 'PENDING'
                 OR ("state" = 'RETRY_SCHEDULED'
                     AND "nextAttemptAt" <= (now() AT TIME ZONE 'utc'))
              ORDER BY COALESCE("nextAttemptAt", "createdAt")
              LIMIT ${options.batchSize}::int
                FOR UPDATE SKIP LOCKED
           ) AS eligible
     WHERE d."id" = eligible."id"
    RETURNING d."id", d."attemptCount"
  `;

  return rows.map((row) => ({ id: row.id, attemptNumber: row.attemptCount }));
}
