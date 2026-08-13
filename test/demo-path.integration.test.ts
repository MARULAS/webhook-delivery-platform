import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { buildServer } from "../src/app/server.ts";
import { createDeliveryWorker } from "../src/worker/delivery-worker.ts";
import { createTestPrisma, ensureEventTypes, resetDatabase, testConfig } from "./helpers/test-db.ts";
import { startTestReceiver, type TestReceiver } from "./helpers/test-receiver.ts";

/**
 * Part 7: one end-to-end run of the documented demo path (SPEC.md section
 * 27), driven entirely through the public REST API against a real local
 * receiver and real PostgreSQL — register an endpoint, subscribe it,
 * publish an event, let the worker deliver it, then read the result back
 * through the same history and metrics endpoints the demo walkthrough uses.
 *
 * Every individual behavior this touches already has focused coverage
 * elsewhere (endpoint/subscription creation, publication, worker delivery,
 * history reads, metrics) — this test's distinct value is exercising the
 * full chain in one place, entirely through the API rather than through
 * Prisma fixtures, which no existing test does. It is deliberately one
 * happy-path test, not a re-run of the retry/failure/manual-retry lifecycle
 * already covered by delivery-retry.integration.test.ts and
 * manual-retry-and-history.integration.test.ts.
 */

const EVENT_TYPE = "order.completed";

const config = testConfig({
  ALLOW_LOCAL_ENDPOINTS: "true",
  WORKER_ENABLED: "false",
  DELIVERY_TIMEOUT_MS: "2000",
});

const prisma = createTestPrisma(config);
const logger = Fastify({ logger: false }).log;
const worker = createDeliveryWorker(prisma, config, logger);
let app: FastifyInstance;
let receiver: TestReceiver;

before(async () => {
  app = await buildServer(config, prisma);
  receiver = await startTestReceiver((_request, res) => {
    res.writeHead(200).end();
  });
  await ensureEventTypes(prisma, [EVENT_TYPE]);
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

test("register, subscribe, publish, deliver, and inspect history and metrics — all through the public API", async () => {
  const endpointResponse = await app.inject({
    method: "POST",
    url: "/endpoints",
    payload: { name: "demo receiver", url: receiver.url("/hook") },
  });
  assert.equal(endpointResponse.statusCode, 201);
  assert.doesNotMatch(endpointResponse.payload, /signingSecret/i);
  const endpointId = endpointResponse.json().id as string;

  const subscribeResponse = await app.inject({
    method: "POST",
    url: `/endpoints/${endpointId}/subscriptions`,
    payload: { eventType: EVENT_TYPE },
  });
  assert.equal(subscribeResponse.statusCode, 201);

  const publishResponse = await app.inject({
    method: "POST",
    url: "/events",
    payload: { type: EVENT_TYPE, payload: { orderId: 42 } },
  });
  assert.equal(publishResponse.statusCode, 201);
  const eventId = publishResponse.json().id as string;

  // Publication must not have delivered anything synchronously — the whole
  // point of the fan-out/worker split (ARCHITECTURE.md section 32).
  assert.equal(receiver.received.length, 0);

  const deliveriesForEvent = await app.inject({ method: "GET", url: `/events/${eventId}/deliveries` });
  assert.equal(deliveriesForEvent.statusCode, 200);
  const deliveries = deliveriesForEvent.json() as { id: string; state: string }[];
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]!.state, "PENDING");
  const deliveryId = deliveries[0]!.id;

  const claimed = await worker.runOnce();
  assert.equal(claimed, 1);
  assert.equal(receiver.received.length, 1, "the worker, not the publish request, made the outbound request");

  const deliveryResponse = await app.inject({ method: "GET", url: `/deliveries/${deliveryId}` });
  assert.equal(deliveryResponse.statusCode, 200);
  assert.equal(deliveryResponse.json().state, "DELIVERED");
  assert.notEqual(deliveryResponse.json().completedAt, null);

  const attemptsResponse = await app.inject({ method: "GET", url: `/deliveries/${deliveryId}/attempts` });
  assert.equal(attemptsResponse.statusCode, 200);
  const attempts = attemptsResponse.json() as { attemptNumber: number; outcome: string; httpStatusCode: number }[];
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]!.attemptNumber, 1);
  assert.equal(attempts[0]!.outcome, "SUCCESS");
  assert.equal(attempts[0]!.httpStatusCode, 200);

  const listByStatus = await app.inject({ method: "GET", url: "/deliveries?status=DELIVERED" });
  assert.equal(listByStatus.statusCode, 200);
  assert.deepEqual(
    (listByStatus.json() as { id: string }[]).map((d) => d.id),
    [deliveryId],
  );

  const metricsResponse = await app.inject({ method: "GET", url: "/metrics" });
  assert.equal(metricsResponse.statusCode, 200);
  const metrics = metricsResponse.json();
  assert.ok(metrics.totalEventsAccepted >= 1);
  assert.ok(metrics.deliveriesDelivered >= 1);
});
