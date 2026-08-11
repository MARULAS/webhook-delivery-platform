import { Prisma } from "../../../generated/prisma/client.ts";
import type { PrismaClient } from "../../infrastructure/database/prisma.ts";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors/app-error.ts";
import { hashPublishRequest } from "./request-hash.ts";

/**
 * Event publication (SPEC.md section 7, IMPLEMENTATION_PLAN.md Part 3).
 *
 * Publishing persists work; it never performs it. There is no outbound HTTP
 * call anywhere in this file and no delivery function is reachable from it —
 * the worker introduced in Part 4 is the only thing that sends a webhook
 * (ARCHITECTURE.md section 32). A `PENDING` Delivery row is the handover.
 *
 * Idempotency (D2) is insert-then-catch, never read-then-insert: a pre-read
 * cannot prevent two concurrent requests from both passing it before either
 * writes, which is exactly the failure that passes every sequential test and
 * duplicates events under load. The unique index on `Event.idempotencyKey`
 * decides the winner.
 */

const EVENT_SELECT = {
  id: true,
  payload: true,
  idempotencyKey: true,
  createdAt: true,
  eventType: { select: { name: true } },
} as const;

interface SelectedEvent {
  id: string;
  payload: Prisma.JsonValue;
  idempotencyKey: string | null;
  createdAt: Date;
  eventType: { name: string };
}

export interface EventResponse {
  id: string;
  type: string;
  payload: unknown;
  idempotencyKey: string | null;
  createdAt: Date;
}

export interface PublishEventInput {
  type: string;
  payload: Record<string, unknown>;
}

export interface PublishEventResult {
  event: EventResponse;
  /** False when an `Idempotency-Key` replay returned an already-stored event. */
  created: boolean;
}

function toEventResponse(event: SelectedEvent): EventResponse {
  return {
    id: event.id,
    type: event.eventType.name,
    payload: event.payload,
    idempotencyKey: event.idempotencyKey,
    createdAt: event.createdAt,
  };
}

export async function publishEvent(
  prisma: PrismaClient,
  input: PublishEventInput,
  idempotencyKey?: string,
): Promise<PublishEventResult> {
  // Domain validation of the event type happens before the transaction so the
  // transaction stays as short as possible. The catalog is seeded and never
  // deleted (D1), so this cannot go stale in practice; the foreign key below
  // is still the authority.
  const eventType = await prisma.eventType.findUnique({
    where: { name: input.type },
    select: { id: true },
  });
  if (!eventType) {
    throw new ValidationError(`Unknown event type "${input.type}".`);
  }

  const requestHash = idempotencyKey === undefined ? null : hashPublishRequest(input.type, input.payload);

  try {
    // One short interactive transaction over the whole operation
    // (ARCHITECTURE.md section 8): insert the event, match subscriptions, and
    // create every delivery row together. Matching is inside the transaction
    // so the accepted event can never be committed with a delivery set that
    // was computed against a different snapshot, or with no set at all.
    const event = await prisma.$transaction(async (tx) => {
      const created = await tx.event.create({
        data: {
          eventTypeId: eventType.id,
          // The payload is validated as a JSON object at the route boundary;
          // the cast only tells Prisma that.
          payload: input.payload as Prisma.InputJsonObject,
          idempotencyKey: idempotencyKey ?? null,
          requestHash,
        },
        select: EVENT_SELECT,
      });

      // SPEC.md section 6: an endpoint receives an event only if it is enabled
      // and holds a subscription to that event's type. The unique
      // (endpointId, eventTypeId) subscription constraint guarantees each
      // endpoint appears at most once here, so the fan-out cannot produce two
      // deliveries for one endpoint.
      //
      // This read snapshots `enabled`. An endpoint disabled between this
      // statement and the commit still receives a PENDING delivery, because
      // the insert below does not re-evaluate the condition. That window is
      // deliberately left open here: locking the endpoint rows would close a
      // window of microseconds while leaving the one that actually matters —
      // the unbounded gap between fan-out and the worker sending the request,
      // during which the endpoint may be disabled at any moment. The
      // enforceable rule is therefore a re-check immediately before sending,
      // which the worker owns (IMPLEMENTATION_PLAN.md Part 4), not a stronger
      // lock here.
      const subscriptions = await tx.subscription.findMany({
        where: { eventTypeId: eventType.id, endpoint: { enabled: true } },
        select: { endpointId: true },
      });

      await tx.delivery.createMany({
        data: subscriptions.map((subscription) => ({
          eventId: created.id,
          endpointId: subscription.endpointId,
        })),
      });

      return created;
    });

    return { event: toEventResponse(event), created: true };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (idempotencyKey !== undefined && err.code === "P2002") {
        // Handled out here on purpose: the constraint violation has already
        // aborted the interactive transaction, so the re-read must happen on a
        // fresh statement through the outer client.
        return replayEvent(prisma, idempotencyKey, requestHash, err);
      }
      if (err.code === "P2003") {
        // An endpoint matched above was deleted before this transaction
        // committed, so its delivery row failed the foreign key. The whole
        // publication rolled back. That is a concurrent modification, not an
        // unexpected server failure, so it must not surface as a 500.
        throw new ConflictError("A subscribed endpoint was modified while the event was being published. Retry the request.");
      }
    }
    throw err;
  }
}

/**
 * Resolves a lost idempotency race by returning the event the winner created.
 *
 * The re-read is guaranteed to find that row: the loser's INSERT blocks on the
 * winner's uncommitted index entry and PostgreSQL only raises the unique
 * violation once the winner has committed. By the time control reaches here
 * the winning row is therefore committed and visible to this new statement.
 */
async function replayEvent(
  prisma: PrismaClient,
  idempotencyKey: string,
  requestHash: string | null,
  originalError: Error,
): Promise<PublishEventResult> {
  const existing = await prisma.event.findUnique({
    where: { idempotencyKey },
    select: { ...EVENT_SELECT, requestHash: true },
  });

  if (!existing) {
    // No event holds this key, so the violation came from some other unique
    // constraint. Rethrowing keeps an unexpected failure visible instead of
    // reporting it as a successful replay.
    throw originalError;
  }

  if (existing.requestHash !== requestHash) {
    // D2: the key was reused for a materially different request. SPEC.md
    // section 19 names this an idempotency conflict.
    throw new ConflictError("This Idempotency-Key was already used for a different event.");
  }

  return { event: toEventResponse(existing), created: false };
}

export async function getEvent(prisma: PrismaClient, eventId: string): Promise<EventResponse> {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: EVENT_SELECT,
  });
  if (!event) {
    throw new NotFoundError("Event not found.");
  }
  return toEventResponse(event);
}
