import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { buildServer } from "../src/app/server.ts";
import { manualRetryDelivery } from "../src/modules/deliveries/state-transitions.ts";
import { createDeliveryWorker } from "../src/worker/delivery-worker.ts";
import { createTestPrisma, ensureEventTypes, resetDatabase, testConfig } from "./helpers/test-db.ts";
import { startTestReceiver, type TestReceiver } from "./helpers/test-receiver.ts";

/**
 * Part 6 integration tests: manual retry (D4's budget reset in particular),
 * delivery/attempt history reads, filtering, pagination, and the
 * confirmation that manual retry cannot mishandle the state machine
 * (IMPLEMENTATION_PLAN.md Part 6 "High-risk areas").
 */

const EVENT_TYPE = "order.completed";
const MAX_ATTEMPTS = 3;

const config = testConfig({
  ALLOW_LOCAL_ENDPOINTS: "true",
  WORKER_ENABLED: "false",
  WORKER_CONCURRENCY: "2",
  WORKER_BATCH_SIZE: "10",
  DELIVERY_TIMEOUT_MS: "300",
  MAX_DELIVERY_ATTEMPTS: String(MAX_ATTEMPTS),
  RETRY_BASE_DELAY_MS: "50",
  RETRY_MAX_DELAY_MS: "60000",
});

const prisma = createTestPrisma(config);
const logger = Fastify({ logger: false }).log;
const worker = createDeliveryWorker(prisma, config, logger);
let app: FastifyInstance;

let receiver: TestReceiver;
let eventTypeId: string;

before(async () => {
  app = await buildServer(config, prisma);
  receiver = await startTestReceiver((request, res) => {
    if (request.path === "/error") {
      res.writeHead(500).end();
      return;
    }
    res.writeHead(200).end();
  });

  await ensureEventTypes(prisma, [EVENT_TYPE]);
  const eventType = await prisma.eventType.findUniqueOrThrow({ where: { name: EVENT_TYPE } });
  eventTypeId = eventType.id;
});

beforeEach(async () => {
  await resetDatabase(prisma);
  receiver.reset();
});

after(async () => {
  await app.close();
  await receiver.close();
  await prisma.$disconnect();
});

interface SeededDelivery {
  deliveryId: string;
  endpointId: string;
  eventId: string;
}

async function seedDelivery(
  url: string,
  data: {
    state?: "PENDING" | "PROCESSING" | "RETRY_SCHEDULED" | "DELIVERED" | "FAILED";
    attemptCount?: number;
    completedAt?: Date;
    failureReason?: string;
    nextAttemptAt?: Date;
  } = {},
): Promise<SeededDelivery> {
  const endpoint = await prisma.webhookEndpoint.create({
    data: { name: "test receiver", url, signingSecret: randomBytes(32).toString("hex") },
  });
  const event = await prisma.event.create({ data: { eventTypeId, payload: { orderId: 1 } } });
  const delivery = await prisma.delivery.create({
    data: {
      eventId: event.id,
      endpointId: endpoint.id,
      state: data.state ?? "PENDING",
      attemptCount: data.attemptCount ?? 0,
      completedAt: data.completedAt,
      failureReason: data.failureReason,
      nextAttemptAt: data.nextAttemptAt,
    },
  });
  return { deliveryId: delivery.id, endpointId: endpoint.id, eventId: event.id };
}

async function createAttempt(deliveryId: string, attemptNumber: number, outcome: "SUCCESS" | "RETRYABLE_FAILURE" | "PERMANENT_FAILURE") {
  return prisma.deliveryAttempt.create({
    data: {
      deliveryId,
      attemptNumber,
      attemptedAt: new Date(Date.now() - 60_000),
      outcome,
      httpStatusCode: outcome === "SUCCESS" ? 200 : 500,
      durationMs: 10,
      errorCategory: outcome === "SUCCESS" ? null : "HTTP_STATUS",
      errorMessage: outcome === "SUCCESS" ? null : "Receiver responded with HTTP 500.",
    },
  });
}

async function retry(deliveryId: string) {
  return app.inject({ method: "POST", url: `/deliveries/${deliveryId}/retry` });
}

test("manual retry accepts a FAILED delivery and resets it to PENDING with a clean terminal snapshot", async () => {
  const seeded = await seedDelivery(receiver.url("/error"), {
    state: "FAILED",
    attemptCount: MAX_ATTEMPTS,
    completedAt: new Date(),
    failureReason: "Delivery failed after 3 automatic attempts.",
  });
  await createAttempt(seeded.deliveryId, 1, "RETRYABLE_FAILURE");
  await createAttempt(seeded.deliveryId, 2, "RETRYABLE_FAILURE");
  await createAttempt(seeded.deliveryId, 3, "RETRYABLE_FAILURE");

  const response = await retry(seeded.deliveryId);
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.state, "PENDING");
  assert.equal(body.completedAt, null);
  assert.equal(body.failureReason, null);
  assert.equal(body.attemptCount, MAX_ATTEMPTS, "attemptCount, the claim fencing token, must never be touched");

  const delivery = await prisma.delivery.findUniqueOrThrow({ where: { id: seeded.deliveryId } });
  assert.equal(delivery.attemptBudgetFloor, MAX_ATTEMPTS, "the budget floor moves to the current attemptCount");
  assert.equal(delivery.nextAttemptAt, null);
});

test("manual retry's budget-floor write is fenced on attemptCount, not on state alone: a stale caller cannot corrupt a newer lifecycle's floor", async () => {
  // The compound race the attemptCount fence closes: a caller reads
  // attemptCount, then before its UPDATE runs, a second manual retry, a
  // worker claim (attemptCount advances), and a re-failure all land the
  // delivery back in FAILED with a *higher* attemptCount. A `state =
  // 'FAILED'` guard alone would still match that row and let the first
  // caller overwrite attemptBudgetFloor with its now-stale read, silently
  // re-including an old attempt in the new lifecycle's budget.
  //
  // The interleaving cannot be forced through genuine concurrency without
  // mocking the Prisma client, so it is reproduced deterministically here:
  // the "stale" caller's read is captured explicitly, the rest of the race
  // is driven to completion, and the stale caller's write is then issued
  // with the exact WHERE clause `manualRetryDelivery` uses (including the
  // attemptCount fence), directly against the real, current database state.
  const seeded = await seedDelivery(receiver.url("/error"), {
    state: "FAILED",
    attemptCount: 5,
    completedAt: new Date(),
    failureReason: "first failure",
  });

  // The stale caller's read, captured before the rest of the race happens.
  const staleRead = await prisma.delivery.findUniqueOrThrow({
    where: { id: seeded.deliveryId },
    select: { attemptCount: true },
  });
  assert.equal(staleRead.attemptCount, 5);

  // The rest of the compound race: a legitimate manual retry through the
  // real function, then a claim and a re-failure advancing attemptCount and
  // landing the row back in FAILED.
  await manualRetryDelivery(prisma, seeded.deliveryId);
  await prisma.delivery.update({
    where: { id: seeded.deliveryId },
    data: { state: "FAILED", attemptCount: 6, completedAt: new Date(), failureReason: "second failure" },
  });

  // The stale caller's write finally lands, fenced on the value it read
  // before any of the above happened.
  const staleWrite = await prisma.delivery.updateMany({
    where: { id: seeded.deliveryId, state: "FAILED", attemptCount: staleRead.attemptCount },
    data: {
      state: "PENDING",
      attemptBudgetFloor: staleRead.attemptCount,
      nextAttemptAt: null,
      completedAt: null,
      failureReason: null,
    },
  });

  assert.equal(
    staleWrite.count,
    0,
    "the stale write must be rejected: attemptCount moved from 5 to 6 underneath it",
  );

  const delivery = await prisma.delivery.findUniqueOrThrow({ where: { id: seeded.deliveryId } });
  assert.equal(delivery.state, "FAILED", "the row must be untouched by the rejected stale write");
  assert.equal(delivery.attemptCount, 6);
  assert.equal(
    delivery.attemptBudgetFloor,
    5,
    "the earlier, non-stale manual retry's floor must survive untouched by the rejected write",
  );
});

test("manual retry is rejected with 409 from every non-FAILED state and changes nothing", async () => {
  const nonFailedStates = ["PENDING", "PROCESSING", "RETRY_SCHEDULED", "DELIVERED"] as const;

  for (const state of nonFailedStates) {
    const seeded = await seedDelivery(receiver.url("/ok"), {
      state,
      attemptCount: 1,
      nextAttemptAt: state === "RETRY_SCHEDULED" ? new Date(Date.now() + 60_000) : undefined,
    });
    const before = await prisma.delivery.findUniqueOrThrow({ where: { id: seeded.deliveryId } });

    const response = await retry(seeded.deliveryId);
    assert.equal(response.statusCode, 409, `expected 409 retrying from ${state}`);
    assert.equal(response.json().error.code, "INVALID_STATE");

    const after = await prisma.delivery.findUniqueOrThrow({ where: { id: seeded.deliveryId } });
    assert.deepEqual(after, before, `delivery must be unchanged after a rejected retry from ${state}`);
  }
});

test("manual retry of an unknown delivery returns 404", async () => {
  const response = await retry("00000000-0000-0000-0000-000000000000");
  assert.equal(response.statusCode, 404);
});

test("manual retry preserves every prior DeliveryAttempt row exactly, numbering continuing rather than restarting", async () => {
  const seeded = await seedDelivery(receiver.url("/error"), {
    state: "FAILED",
    attemptCount: 2,
    completedAt: new Date(),
    failureReason: "permanent failure",
  });
  await createAttempt(seeded.deliveryId, 1, "RETRYABLE_FAILURE");
  await createAttempt(seeded.deliveryId, 2, "PERMANENT_FAILURE");

  const before = await prisma.deliveryAttempt.findMany({
    where: { deliveryId: seeded.deliveryId },
    orderBy: { attemptNumber: "asc" },
  });

  const response = await retry(seeded.deliveryId);
  assert.equal(response.statusCode, 200);

  const after = await prisma.deliveryAttempt.findMany({
    where: { deliveryId: seeded.deliveryId },
    orderBy: { attemptNumber: "asc" },
  });
  assert.deepEqual(after, before, "manual retry must not touch existing attempt rows");

  // Drive one more real attempt through the worker; the next attempt number
  // must continue the sequence rather than restart at 1.
  await worker.runOnce();
  const attempts = await prisma.deliveryAttempt.findMany({
    where: { deliveryId: seeded.deliveryId },
    orderBy: { attemptNumber: "asc" },
  });
  assert.equal(attempts.length, 3);
  assert.equal(attempts[2]!.attemptNumber, 3);
});

test("manual retry actually resets the automatic-retry budget: the worker does not immediately re-fail a retried delivery", async () => {
  const seeded = await seedDelivery(receiver.url("/error"));

  // Exhaust the budget through the real worker so the delivery reaches FAILED
  // exactly the way production does.
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    await worker.runOnce();
    if (attempt < MAX_ATTEMPTS) {
      await prisma.delivery.update({
        where: { id: seeded.deliveryId },
        data: { nextAttemptAt: new Date(Date.now() - 1000) },
      });
    }
  }
  const failed = await prisma.delivery.findUniqueOrThrow({ where: { id: seeded.deliveryId } });
  assert.equal(failed.state, "FAILED");
  assert.equal(await prisma.deliveryAttempt.count({ where: { deliveryId: seeded.deliveryId } }), MAX_ATTEMPTS);

  const response = await retry(seeded.deliveryId);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().state, "PENDING");

  // The receiver is still failing. Without the budget reset (D4), the very
  // next attempt would see attemptsMade >= MAX_ATTEMPTS and go straight back
  // to FAILED, making the feature inert.
  await worker.runOnce();

  const delivery = await prisma.delivery.findUniqueOrThrow({ where: { id: seeded.deliveryId } });
  const attempts = await prisma.deliveryAttempt.findMany({
    where: { deliveryId: seeded.deliveryId },
    orderBy: { attemptNumber: "asc" },
  });

  assert.equal(delivery.state, "RETRY_SCHEDULED", "the reset budget must allow at least one more retry");
  assert.equal(attempts.length, MAX_ATTEMPTS + 1, "the monotonic attempt sequence continues rather than restarting");
  assert.equal(attempts[MAX_ATTEMPTS]!.attemptNumber, MAX_ATTEMPTS + 1);

  // And exhausting the *new* budget still terminates normally.
  await prisma.delivery.update({ where: { id: seeded.deliveryId }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
  await worker.runOnce();
  const stillRetrying = await prisma.delivery.findUniqueOrThrow({ where: { id: seeded.deliveryId } });
  assert.equal(stillRetrying.state, "RETRY_SCHEDULED");
  await prisma.delivery.update({ where: { id: seeded.deliveryId }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
  await worker.runOnce();
  const refailed = await prisma.delivery.findUniqueOrThrow({ where: { id: seeded.deliveryId } });
  assert.equal(refailed.state, "FAILED");
  assert.equal(await prisma.deliveryAttempt.count({ where: { deliveryId: seeded.deliveryId } }), MAX_ATTEMPTS * 2);
});

test("GET /deliveries/:deliveryId returns the delivery, and 404s for an unknown id", async () => {
  const seeded = await seedDelivery(receiver.url("/ok"), { state: "DELIVERED", attemptCount: 1, completedAt: new Date() });

  const response = await app.inject({ method: "GET", url: `/deliveries/${seeded.deliveryId}` });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.id, seeded.deliveryId);
  assert.equal(body.eventId, seeded.eventId);
  assert.equal(body.endpointId, seeded.endpointId);
  assert.equal(body.state, "DELIVERED");

  const missing = await app.inject({ method: "GET", url: "/deliveries/00000000-0000-0000-0000-000000000000" });
  assert.equal(missing.statusCode, 404);
});

test("GET /deliveries/:deliveryId/attempts returns full attempt history in order, and 404s for an unknown delivery", async () => {
  const seeded = await seedDelivery(receiver.url("/ok"));
  await createAttempt(seeded.deliveryId, 1, "RETRYABLE_FAILURE");
  await createAttempt(seeded.deliveryId, 2, "SUCCESS");

  const response = await app.inject({ method: "GET", url: `/deliveries/${seeded.deliveryId}/attempts` });
  assert.equal(response.statusCode, 200);
  const attempts = response.json();
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].attemptNumber, 1);
  assert.equal(attempts[0].outcome, "RETRYABLE_FAILURE");
  assert.equal(attempts[1].attemptNumber, 2);
  assert.equal(attempts[1].outcome, "SUCCESS");
  assert.equal(attempts[1].httpStatusCode, 200);

  const missing = await app.inject({ method: "GET", url: "/deliveries/00000000-0000-0000-0000-000000000000/attempts" });
  assert.equal(missing.statusCode, 404);
});

test("GET /deliveries filters by status, endpointId, and eventId, and rejects an invalid status with 400", async () => {
  const delivered = await seedDelivery(receiver.url("/ok"), { state: "DELIVERED", completedAt: new Date() });
  const failed = await seedDelivery(receiver.url("/error"), { state: "FAILED", completedAt: new Date(), failureReason: "x" });
  const pending = await seedDelivery(receiver.url("/ok"), { state: "PENDING" });

  const byStatus = await app.inject({ method: "GET", url: "/deliveries?status=FAILED" });
  assert.equal(byStatus.statusCode, 200);
  const byStatusIds = byStatus.json().map((d: { id: string }) => d.id);
  assert.deepEqual(byStatusIds, [failed.deliveryId]);

  const byEndpoint = await app.inject({ method: "GET", url: `/deliveries?endpointId=${delivered.endpointId}` });
  assert.deepEqual(byEndpoint.json().map((d: { id: string }) => d.id), [delivered.deliveryId]);

  const byEvent = await app.inject({ method: "GET", url: `/deliveries?eventId=${pending.eventId}` });
  assert.deepEqual(byEvent.json().map((d: { id: string }) => d.id), [pending.deliveryId]);

  const invalid = await app.inject({ method: "GET", url: "/deliveries?status=NOT_A_STATE" });
  assert.equal(invalid.statusCode, 400);
});

test("GET /deliveries enforces bounded pagination: default and max limit, and offset slices results", async () => {
  const seeded: SeededDelivery[] = [];
  for (let i = 0; i < 5; i += 1) {
    seeded.push(await seedDelivery(receiver.url("/ok")));
  }

  const overMax = await app.inject({ method: "GET", url: "/deliveries?limit=201" });
  assert.equal(overMax.statusCode, 400);

  const belowMin = await app.inject({ method: "GET", url: "/deliveries?limit=0" });
  assert.equal(belowMin.statusCode, 400);

  const badOffset = await app.inject({ method: "GET", url: "/deliveries?offset=-1" });
  assert.equal(badOffset.statusCode, 400);

  const page1 = await app.inject({ method: "GET", url: "/deliveries?limit=2&offset=0" });
  assert.equal(page1.statusCode, 200);
  assert.equal(page1.json().length, 2);

  const page2 = await app.inject({ method: "GET", url: "/deliveries?limit=2&offset=2" });
  assert.equal(page2.json().length, 2);

  const page1Ids = page1.json().map((d: { id: string }) => d.id);
  const page2Ids = page2.json().map((d: { id: string }) => d.id);
  assert.equal(page1Ids.some((id: string) => page2Ids.includes(id)), false, "pages must not overlap");

  const all = await app.inject({ method: "GET", url: "/deliveries" });
  assert.equal(all.json().length, 5, "the default limit comfortably covers this fixture");
});
