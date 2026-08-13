import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/app/server.ts";
import { createTestPrisma, ensureEventTypes, resetDatabase, testConfig } from "./helpers/test-db.ts";

/**
 * Part 6: one integration test asserting metrics against a deterministic
 * fixture (IMPLEMENTATION_PLAN.md Part 6 "Testing and checks required").
 */

const EVENT_TYPE = "order.completed";
const config = testConfig();
const prisma = createTestPrisma(config);
let app: FastifyInstance;
let eventTypeId: string;

before(async () => {
  app = await buildServer(config, prisma);
  await ensureEventTypes(prisma, [EVENT_TYPE]);
  eventTypeId = (await prisma.eventType.findUniqueOrThrow({ where: { name: EVENT_TYPE } })).id;
});

beforeEach(async () => {
  await resetDatabase(prisma);
});

after(async () => {
  await app.close();
  await prisma.$disconnect();
});

async function makeEndpoint() {
  return prisma.webhookEndpoint.create({
    data: { name: "receiver", url: "https://example.com/hook", signingSecret: randomBytes(32).toString("hex") },
  });
}

async function makeDelivery(
  endpointId: string,
  state: "PENDING" | "PROCESSING" | "RETRY_SCHEDULED" | "DELIVERED" | "FAILED",
) {
  const event = await prisma.event.create({ data: { eventTypeId, payload: {} } });
  return prisma.delivery.create({ data: { eventId: event.id, endpointId, state } });
}

test("metrics match the underlying rows exactly for a known fixture", async () => {
  const endpoint = await makeEndpoint();

  // 3 events accepted.
  const d1 = await makeDelivery(endpoint.id, "DELIVERED");
  const d2 = await makeDelivery(endpoint.id, "DELIVERED");
  const d3 = await makeDelivery(endpoint.id, "FAILED");
  const d4 = await makeDelivery(endpoint.id, "PENDING");
  const d5 = await makeDelivery(endpoint.id, "RETRY_SCHEDULED");
  await prisma.event.create({ data: { eventTypeId, payload: {} } }); // event with no deliveries

  // Successful attempts: durations 100 and 300 -> average 200.
  await prisma.deliveryAttempt.create({
    data: {
      deliveryId: d1.id,
      attemptNumber: 1,
      attemptedAt: new Date(),
      outcome: "SUCCESS",
      httpStatusCode: 200,
      durationMs: 100,
    },
  });
  await prisma.deliveryAttempt.create({
    data: {
      deliveryId: d2.id,
      attemptNumber: 1,
      attemptedAt: new Date(),
      outcome: "SUCCESS",
      httpStatusCode: 200,
      durationMs: 300,
    },
  });
  // A failed attempt's duration must not pollute the SUCCESS-only average.
  await prisma.deliveryAttempt.create({
    data: {
      deliveryId: d3.id,
      attemptNumber: 1,
      attemptedAt: new Date(),
      outcome: "PERMANENT_FAILURE",
      httpStatusCode: 400,
      durationMs: 9999,
      errorCategory: "HTTP_STATUS",
      errorMessage: "Receiver responded with HTTP 400.",
    },
  });

  const response = await app.inject({ method: "GET", url: "/metrics" });
  assert.equal(response.statusCode, 200);
  const metrics = response.json();

  assert.equal(metrics.totalEventsAccepted, 6);
  assert.equal(metrics.totalDeliveriesCreated, 5);
  assert.equal(metrics.deliveriesDelivered, 2);
  assert.equal(metrics.deliveriesFailed, 1);
  assert.equal(metrics.deliveriesPendingOrRetrying, 2, "PENDING + RETRY_SCHEDULED");
  assert.equal(metrics.successRate, 2 / 3, "2 delivered of 3 terminal deliveries");
  assert.equal(metrics.averageDeliveryDurationMs, 200, "average of SUCCESS attempts only: (100 + 300) / 2");
});

test("metrics report null success rate and average duration on an empty database", async () => {
  const response = await app.inject({ method: "GET", url: "/metrics" });
  assert.equal(response.statusCode, 200);
  const metrics = response.json();

  assert.equal(metrics.totalEventsAccepted, 0);
  assert.equal(metrics.totalDeliveriesCreated, 0);
  assert.equal(metrics.successRate, null);
  assert.equal(metrics.averageDeliveryDurationMs, null);
});
