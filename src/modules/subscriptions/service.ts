import { Prisma } from "../../../generated/prisma/client.ts";
import type { PrismaClient } from "../../infrastructure/database/prisma.ts";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors/app-error.ts";

/**
 * Subscription management (SPEC.md section 6, IMPLEMENTATION_PLAN.md Part 2).
 *
 * Event types are referenced by their name (e.g. "order.created"), matching
 * how SPEC.md represents event types everywhere else (see the `POST /events`
 * example in section 7). The EventType catalog itself has no public route —
 * it is seeded, not managed through the API (D1) — so the name is resolved
 * to its internal id here.
 *
 * The duplicate-(endpoint, eventType) case is handled by attempting the
 * insert and catching the database's unique-constraint violation (P2002),
 * not by an application-level "check then insert" pre-check, per
 * ENGINEERING_RULES.md section 7/10: a pre-check alone cannot prevent two
 * concurrent requests from both passing it before either writes.
 */

export interface SubscriptionResponse {
  id: string;
  endpointId: string;
  eventTypeId: string;
  eventType: string;
  createdAt: Date;
}

export interface CreateSubscriptionInput {
  eventType: string;
}

async function assertEndpointExists(prisma: PrismaClient, endpointId: string): Promise<void> {
  const endpoint = await prisma.webhookEndpoint.findUnique({
    where: { id: endpointId },
    select: { id: true },
  });
  if (!endpoint) {
    throw new NotFoundError("Webhook endpoint not found.");
  }
}

export async function createSubscription(
  prisma: PrismaClient,
  endpointId: string,
  input: CreateSubscriptionInput,
): Promise<SubscriptionResponse> {
  await assertEndpointExists(prisma, endpointId);

  const eventType = await prisma.eventType.findUnique({ where: { name: input.eventType } });
  if (!eventType) {
    throw new ValidationError(`Unknown event type "${input.eventType}".`);
  }

  try {
    const subscription = await prisma.subscription.create({
      data: { endpointId, eventTypeId: eventType.id },
      select: { id: true, endpointId: true, eventTypeId: true, createdAt: true },
    });
    return { ...subscription, eventType: eventType.name };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === "P2002") {
        throw new ConflictError("Endpoint is already subscribed to this event type.");
      }
      if (err.code === "P2003") {
        // The endpoint was deleted between the existence check above and
        // this insert.
        throw new NotFoundError("Webhook endpoint not found.");
      }
    }
    throw err;
  }
}

export async function listSubscriptions(prisma: PrismaClient, endpointId: string): Promise<SubscriptionResponse[]> {
  await assertEndpointExists(prisma, endpointId);

  const subscriptions = await prisma.subscription.findMany({
    where: { endpointId },
    select: {
      id: true,
      endpointId: true,
      eventTypeId: true,
      createdAt: true,
      eventType: { select: { name: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  return subscriptions.map((subscription) => ({
    id: subscription.id,
    endpointId: subscription.endpointId,
    eventTypeId: subscription.eventTypeId,
    eventType: subscription.eventType.name,
    createdAt: subscription.createdAt,
  }));
}

export async function deleteSubscription(
  prisma: PrismaClient,
  endpointId: string,
  subscriptionId: string,
): Promise<void> {
  const result = await prisma.subscription.deleteMany({
    where: { id: subscriptionId, endpointId },
  });
  if (result.count === 0) {
    throw new NotFoundError("Subscription not found.");
  }
}
