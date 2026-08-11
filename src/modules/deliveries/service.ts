import type { DeliveryState } from "../../../generated/prisma/client.ts";
import type { PrismaClient } from "../../infrastructure/database/prisma.ts";
import { NotFoundError } from "../../shared/errors/app-error.ts";

/**
 * Delivery reads (IMPLEMENTATION_PLAN.md Part 3 lists this module as read-side
 * only). Deliveries are created by event publication and, from Part 4 onwards,
 * advanced by the worker; nothing here writes or executes one.
 *
 * The projection carries endpoint and event identifiers only. It never joins
 * the endpoint row, so a signing secret cannot reach a response through it.
 */

const DELIVERY_PUBLIC_SELECT = {
  id: true,
  eventId: true,
  endpointId: true,
  state: true,
  createdAt: true,
  updatedAt: true,
} as const;

export interface DeliveryResponse {
  id: string;
  eventId: string;
  endpointId: string;
  state: DeliveryState;
  createdAt: Date;
  updatedAt: Date;
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
