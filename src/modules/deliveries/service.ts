import type {
  DeliveryAttemptOutcome,
  DeliveryErrorCategory,
  DeliveryState,
} from "../../../generated/prisma/client.ts";
import type { PrismaClient } from "../../infrastructure/database/prisma.ts";
import { NotFoundError } from "../../shared/errors/app-error.ts";
import { manualRetryDelivery } from "./state-transitions.ts";

/**
 * Delivery reads (Part 3), history (Part 6), and manual retry (Part 6, D4).
 * Deliveries are created by event publication and advanced by the worker;
 * nothing here executes one — manual retry only flips FAILED back to PENDING
 * through `manualRetryDelivery` in state-transitions.ts, the single home for
 * delivery state changes (ARCHITECTURE.md section 16).
 *
 * The projection carries endpoint and event identifiers only. It never joins
 * the endpoint row, so a signing secret cannot reach a response through it.
 */

const DELIVERY_PUBLIC_SELECT = {
  id: true,
  eventId: true,
  endpointId: true,
  state: true,
  attemptCount: true,
  createdAt: true,
  updatedAt: true,
  nextAttemptAt: true,
  completedAt: true,
  failureReason: true,
} as const;

export interface DeliveryResponse {
  id: string;
  eventId: string;
  endpointId: string;
  state: DeliveryState;
  attemptCount: number;
  createdAt: Date;
  updatedAt: Date;
  nextAttemptAt: Date | null;
  completedAt: Date | null;
  failureReason: string | null;
}

export interface DeliveryAttemptResponse {
  attemptNumber: number;
  attemptedAt: Date;
  outcome: DeliveryAttemptOutcome;
  httpStatusCode: number | null;
  durationMs: number;
  errorCategory: DeliveryErrorCategory | null;
  errorMessage: string | null;
}

/**
 * Lists the deliveries generated for one event. An unknown event is a 404
 * rather than an empty list, so a caller can tell "no matching subscriptions"
 * apart from "wrong id".
 */
export async function listDeliveriesForEvent(prisma: PrismaClient, eventId: string): Promise<DeliveryResponse[]> {
  const event = await prisma.event.findUnique({ where: { id: eventId }, select: { id: true } });
  if (!event) {
    throw new NotFoundError("Event not found.");
  }

  // Served by the leading column of the unique (eventId, endpointId) index.
  return prisma.delivery.findMany({
    where: { eventId },
    select: DELIVERY_PUBLIC_SELECT,
    orderBy: { createdAt: "asc" },
  });
}

export async function getDelivery(prisma: PrismaClient, deliveryId: string): Promise<DeliveryResponse> {
  const delivery = await prisma.delivery.findUnique({
    where: { id: deliveryId },
    select: DELIVERY_PUBLIC_SELECT,
  });
  if (!delivery) {
    throw new NotFoundError("Delivery not found.");
  }
  return delivery;
}

/**
 * A delivery's full attempt-by-attempt history (SPEC.md section 17), ordered
 * by attempt number ascending — the order the attempts actually happened in,
 * for the normal case; see the ordering caveat in state-transitions.ts for
 * the rare case of a stale worker's attempt landing out of order.
 */
export async function listDeliveryAttempts(
  prisma: PrismaClient,
  deliveryId: string,
): Promise<DeliveryAttemptResponse[]> {
  const delivery = await prisma.delivery.findUnique({ where: { id: deliveryId }, select: { id: true } });
  if (!delivery) {
    throw new NotFoundError("Delivery not found.");
  }

  return prisma.deliveryAttempt.findMany({
    where: { deliveryId },
    select: {
      attemptNumber: true,
      attemptedAt: true,
      outcome: true,
      httpStatusCode: true,
      durationMs: true,
      errorCategory: true,
      errorMessage: true,
    },
    orderBy: { attemptNumber: "asc" },
  });
}

export interface ListDeliveriesFilter {
  status?: DeliveryState;
  endpointId?: string;
  eventId?: string;
  limit: number;
  offset: number;
}

/**
 * The operational delivery list (SPEC.md section 17). Filter values are
 * already validated at the Fastify schema boundary (schemas.ts): an unknown
 * status enum value or a non-integer/out-of-range limit or offset never
 * reaches here. An `endpointId`/`eventId` that does not exist is simply a
 * filter that matches nothing, not a 404 — unlike a single delivery or a
 * single event lookup, a list is allowed to be empty.
 *
 * Every filter is served by an existing index or column:
 *   - `status` alone: the leading column of `[state, createdAt]`.
 *   - `endpointId` alone: the dedicated `[endpointId]` index.
 *   - `eventId` alone: the leading column of the unique `[eventId, endpointId]`.
 *   - any combination: PostgreSQL uses one index and filters the rest, which
 *     is adequate at this project's scale (ARCHITECTURE.md section 25).
 * No new index is added for this query pattern.
 */
export async function listDeliveries(
  prisma: PrismaClient,
  filter: ListDeliveriesFilter,
): Promise<DeliveryResponse[]> {
  return prisma.delivery.findMany({
    where: {
      ...(filter.status !== undefined ? { state: filter.status } : {}),
      ...(filter.endpointId !== undefined ? { endpointId: filter.endpointId } : {}),
      ...(filter.eventId !== undefined ? { eventId: filter.eventId } : {}),
    },
    select: DELIVERY_PUBLIC_SELECT,
    orderBy: { createdAt: "desc" },
    take: filter.limit,
    skip: filter.offset,
  });
}

/**
 * Manual retry (SPEC.md section 11, D4). Delegates the actual state change to
 * `manualRetryDelivery`, which throws `NotFoundError`/`InvalidStateError`
 * exactly as this route needs, then re-reads the row in the same public shape
 * every other delivery-returning endpoint uses.
 */
export async function retryDelivery(prisma: PrismaClient, deliveryId: string): Promise<DeliveryResponse> {
  await manualRetryDelivery(prisma, deliveryId);
  return getDelivery(prisma, deliveryId);
}
