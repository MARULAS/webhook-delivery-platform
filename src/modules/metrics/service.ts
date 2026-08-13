import type { PrismaClient } from "../../infrastructure/database/prisma.ts";

/**
 * Basic operational metrics (SPEC.md section 18, ARCHITECTURE.md section 25).
 *
 * Every number is computed fresh from persisted rows on each request via
 * aggregate PostgreSQL queries (Prisma `count`/`groupBy`/`aggregate`) — no
 * process-local counter, no separate metrics store, no time series. At this
 * project's scale a handful of aggregate queries over indexed columns is
 * adequate; nothing here is optimized further without evidence it needs to be
 * (ARCHITECTURE.md section 25).
 *
 * `averageDeliveryDurationMs` is documented as averaged over attempts that
 * *succeeded* (`outcome = 'SUCCESS'`), not every attempt ever made. SPEC.md
 * section 18 does not specify which; averaging in failed and timed-out
 * attempts would blend genuinely different things (a receiver's real response
 * time vs. this platform's configured request timeout) into one number that
 * describes neither. "How long does a delivery that actually got through
 * take" is the more operationally useful question, so that is what this
 * reports.
 */

export interface MetricsResponse {
  totalEventsAccepted: number;
  totalDeliveriesCreated: number;
  deliveriesDelivered: number;
  deliveriesFailed: number;
  deliveriesPendingOrRetrying: number;
  /** delivered / (delivered + failed); null when neither has happened yet. */
  successRate: number | null;
  /** Average `durationMs` of SUCCESS attempts only; see the module comment. */
  averageDeliveryDurationMs: number | null;
}

export async function getMetrics(prisma: PrismaClient): Promise<MetricsResponse> {
  const [totalEventsAccepted, totalDeliveriesCreated, stateCounts, successDuration] = await Promise.all([
    prisma.event.count(),
    prisma.delivery.count(),
    // One grouped query rather than four separate `count({ where: { state } })`
    // calls: PostgreSQL scans the state-leading index once instead of four
    // times for the same information.
    prisma.delivery.groupBy({ by: ["state"], _count: { _all: true } }),
    prisma.deliveryAttempt.aggregate({
      where: { outcome: "SUCCESS" },
      _avg: { durationMs: true },
    }),
  ]);

  const countByState = new Map(stateCounts.map((row) => [row.state, row._count._all]));
  const deliveriesDelivered = countByState.get("DELIVERED") ?? 0;
  const deliveriesFailed = countByState.get("FAILED") ?? 0;
  const deliveriesPendingOrRetrying =
    (countByState.get("PENDING") ?? 0) +
    (countByState.get("PROCESSING") ?? 0) +
    (countByState.get("RETRY_SCHEDULED") ?? 0);

  const successRateDenominator = deliveriesDelivered + deliveriesFailed;
  const successRate = successRateDenominator === 0 ? null : deliveriesDelivered / successRateDenominator;

  return {
    totalEventsAccepted,
    totalDeliveriesCreated,
    deliveriesDelivered,
    deliveriesFailed,
    deliveriesPendingOrRetrying,
    successRate,
    averageDeliveryDurationMs: successDuration._avg.durationMs ?? null,
  };
}
