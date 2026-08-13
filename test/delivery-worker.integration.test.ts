import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import Fastify from "fastify";
import { claimPendingDeliveries } from "../src/worker/delivery-claiming.ts";
import { createDeliveryWorker } from "../src/worker/delivery-worker.ts";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER } from "../src/infrastructure/security/signing.ts";
import { createTestPrisma, ensureEventTypes, resetDatabase, testConfig } from "./helpers/test-db.ts";
import { reserveClosedPort, startTestReceiver, type TestReceiver } from "./helpers/test-receiver.ts";

/**
 * Part 4 integration tests, against real PostgreSQL and a real local HTTP
 * receiver. These cover the acceptance criteria that only genuine concurrency
 * and a genuine socket can demonstrate: atomic claiming, the bounded
 * concurrency limit, one attempt row per real request, failure isolation, and
 * the pre-delivery endpoint re-checks.
 */

const EVENT_TYPE = "order.completed";
const DELIVERY_TIMEOUT_MS = 300;
const RECEIVER_DELAY_MS = 800; // comfortably beyond the delivery timeout
const HOLD_MS = 60;

const config = testConfig({
  // D5: the loopback exemption exists precisely so a local test receiver can
  // be delivered to. It is never switched off to make a test pass.
  ALLOW_LOCAL_ENDPOINTS: "true",
  // Tests drive the worker one iteration at a time rather than racing a loop.
  WORKER_ENABLED: "false",
  WORKER_CONCURRENCY: "2",
  WORKER_BATCH_SIZE: "10",
  DELIVERY_TIMEOUT_MS: String(DELIVERY_TIMEOUT_MS),
});

const prisma = createTestPrisma(config);
const logger = Fastify({ logger: false }).log;
const worker = createDeliveryWorker(prisma, config, logger);

let receiver: TestReceiver;
let closedPort: number;
let eventTypeId: string;
let inflight = 0;
let maxInflight = 0;

before(async () => {
  closedPort = await reserveClosedPort();
  receiver = await startTestReceiver((request, res) => {
    if (request.path === "/error") {
      res.writeHead(500).end();
      return;
    }
    if (request.path === "/gone") {
      res.writeHead(404).end();
      return;
    }
    if (request.path === "/slow") {
      setTimeout(() => res.writeHead(200).end(), RECEIVER_DELAY_MS).unref();
      return;
    }
    if (request.path === "/hold") {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      setTimeout(() => {
        res.writeHead(200).end();
        inflight -= 1;
      }, HOLD_MS).unref();
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
  inflight = 0;
  maxInflight = 0;
});

after(async () => {
  await receiver.close();
  await prisma.$disconnect();
});

interface SeededDelivery {
  deliveryId: string;
  endpointId: string;
  eventId: string;
  secret: string;
}

/**
 * Seeds one PENDING delivery directly. Endpoints are created through Prisma
 * rather than the API on purpose: the "URL is no longer safe" case has to
 * produce a stored URL that endpoint creation would have rejected, which is
 * exactly what a URL changed outside the API, or a tightened safety rule,
 * would leave behind.
 */
async function seedDelivery(url: string, options: { enabled?: boolean } = {}): Promise<SeededDelivery> {
  const secret = randomBytes(32).toString("hex");
  const endpoint = await prisma.webhookEndpoint.create({
    data: { name: "test receiver", url, signingSecret: secret, enabled: options.enabled ?? true },
  });
  const event = await prisma.event.create({
    data: { eventTypeId, payload: { orderId: 5821, amount: 1499 } },
  });
  const delivery = await prisma.delivery.create({
    data: { eventId: event.id, endpointId: endpoint.id },
  });
  return { deliveryId: delivery.id, endpointId: endpoint.id, eventId: event.id, secret };
}

test("a 2xx delivery is DELIVERED and its signature verifies against the exact transmitted bytes", async () => {
  const seeded = await seedDelivery(receiver.url("/ok"));

  await worker.runOnce();

  assert.equal(receiver.received.length, 1);
  const request = receiver.received[0]!;

  // Verify exactly as a receiver would: over the raw bytes off the wire, not
  // over a re-serialization of the parsed body.
  const timestamp = request.headers[TIMESTAMP_HEADER];
  assert.equal(typeof timestamp, "string");
  const expected = createHmac("sha256", seeded.secret)
    .update(`${timestamp as string}.`)
    .update(request.rawBody)
    .digest("hex");
  assert.equal(request.headers[SIGNATURE_HEADER], `sha256=${expected}`);

  // The timestamp is sent as well as signed, so a receiver can apply a
  // tolerance window (SPEC.md section 14).
  const skewSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  assert.ok(skewSeconds < 60, `timestamp skew was ${skewSeconds}s`);

  const envelope = JSON.parse(request.rawBody.toString("utf8")) as Record<string, unknown>;
  assert.equal(envelope.deliveryId, seeded.deliveryId);
  assert.equal(envelope.eventId, seeded.eventId);
  assert.equal(envelope.type, EVENT_TYPE);
  assert.deepEqual(envelope.payload, { orderId: 5821, amount: 1499 });
  assert.equal(request.rawBody.includes(seeded.secret), false);

  const delivery = await prisma.delivery.findUniqueOrThrow({ where: { id: seeded.deliveryId } });
  assert.equal(delivery.state, "DELIVERED");
  assert.notEqual(delivery.completedAt, null);
  assert.equal(delivery.failureReason, null);
  assert.equal(delivery.attemptCount, 1);

  const attempts = await prisma.deliveryAttempt.findMany({ where: { deliveryId: seeded.deliveryId } });
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]!.attemptNumber, 1);
  assert.equal(attempts[0]!.outcome, "SUCCESS");
  assert.equal(attempts[0]!.httpStatusCode, 200);
  assert.equal(attempts[0]!.errorCategory, null);
  assert.ok(attempts[0]!.durationMs >= 0);
});

test("every receiver outcome records exactly one attempt, and one failing delivery does not stop the others", async () => {
  // Part 5 routes a retryable failure to RETRY_SCHEDULED rather than FAILED;
  // the attempt recording asserted here is unchanged from Part 4.
  const cases = [
    { name: "2xx", url: receiver.url("/ok"), state: "DELIVERED", outcome: "SUCCESS", category: null, status: 200 },
    { name: "5xx", url: receiver.url("/error"), state: "RETRY_SCHEDULED", outcome: "RETRYABLE_FAILURE", category: "HTTP_STATUS", status: 500 },
    { name: "non-retryable 4xx", url: receiver.url("/gone"), state: "FAILED", outcome: "PERMANENT_FAILURE", category: "HTTP_STATUS", status: 404 },
    { name: "timeout", url: receiver.url("/slow"), state: "RETRY_SCHEDULED", outcome: "RETRYABLE_FAILURE", category: "TIMEOUT", status: null },
    { name: "connection failure", url: `http://127.0.0.1:${closedPort}/ok`, state: "RETRY_SCHEDULED", outcome: "RETRYABLE_FAILURE", category: "CONNECTION_ERROR", status: null },
  ] as const;

  const seeded: SeededDelivery[] = [];
  for (const testCase of cases) {
    seeded.push(await seedDelivery(testCase.url));
  }

  // All five in one batch: the successful delivery must complete despite
  // sharing the batch with a 5xx, a timeout, and a refused connection.
  const claimedCount = await worker.runOnce();
  assert.equal(claimedCount, cases.length);

  for (const [index, testCase] of cases.entries()) {
    const { deliveryId } = seeded[index]!;
    const delivery = await prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } });
    const attempts = await prisma.deliveryAttempt.findMany({ where: { deliveryId } });

    assert.equal(attempts.length, 1, `${testCase.name}: expected exactly one attempt`);
    assert.equal(attempts[0]!.attemptNumber, 1, testCase.name);
    assert.equal(attempts[0]!.outcome, testCase.outcome, testCase.name);
    assert.equal(attempts[0]!.errorCategory, testCase.category, testCase.name);
    assert.equal(attempts[0]!.httpStatusCode, testCase.status, testCase.name);
    assert.ok(attempts[0]!.durationMs >= 0, testCase.name);

    assert.equal(delivery.state, testCase.state, testCase.name);
    if (testCase.state === "RETRY_SCHEDULED") {
      assert.equal(delivery.completedAt, null, testCase.name);
      assert.notEqual(delivery.nextAttemptAt, null, testCase.name);
    } else {
      assert.notEqual(delivery.completedAt, null, testCase.name);
    }
    if (testCase.state === "FAILED") {
      assert.equal(delivery.failureReason, attempts[0]!.errorMessage, testCase.name);
      assert.equal(delivery.failureReason?.includes(seeded[index]!.secret), false, testCase.name);
    }
  }
});

test("two parallel claims never return the same delivery, and every claim carries a lease longer than the timeout", async () => {
  const total = 6;
  for (let i = 0; i < total; i += 1) {
    await seedDelivery(receiver.url("/ok"));
  }

  // Separate clients so the two claims run on genuinely separate PostgreSQL
  // sessions rather than being serialized on one pooled connection.
  const clientA = createTestPrisma(config);
  const clientB = createTestPrisma(config);

  try {
    const [claimA, claimB] = await Promise.all([
      claimPendingDeliveries(clientA, { batchSize: total, leaseMs: config.deliveryLeaseMs }),
      claimPendingDeliveries(clientB, { batchSize: total, leaseMs: config.deliveryLeaseMs }),
    ]);

    const idsA = new Set(claimA.map((claim) => claim.id));
    const idsB = new Set(claimB.map((claim) => claim.id));
    assert.equal(idsA.size, claimA.length, "a single claim returned a duplicate row");
    assert.equal(idsB.size, claimB.length, "a single claim returned a duplicate row");
    for (const id of idsB) {
      assert.equal(idsA.has(id), false, "the same delivery was claimed twice");
    }
    assert.equal(claimA.length + claimB.length, total);

    const claimed = await prisma.delivery.findMany();
    for (const delivery of claimed) {
      assert.equal(delivery.state, "PROCESSING");
      assert.equal(delivery.attemptCount, 1, "a claim must mint exactly one attempt number");
      assert.notEqual(delivery.claimedAt, null);
      assert.notEqual(delivery.leaseUntil, null);
      const leaseMs = delivery.leaseUntil!.getTime() - delivery.claimedAt!.getTime();
      assert.ok(
        leaseMs > DELIVERY_TIMEOUT_MS,
        `lease of ${leaseMs}ms must exceed the ${DELIVERY_TIMEOUT_MS}ms delivery timeout`,
      );
    }
  } finally {
    await clientA.$disconnect();
    await clientB.$disconnect();
  }
});

test("active outbound requests never exceed the configured concurrency limit", async () => {
  const total = 6;
  for (let i = 0; i < total; i += 1) {
    await seedDelivery(receiver.url("/hold"));
  }

  await worker.runOnce();

  assert.equal(receiver.received.length, total);
  assert.ok(
    maxInflight <= config.workerConcurrency,
    `${maxInflight} requests were in flight at once, limit is ${config.workerConcurrency}`,
  );
  // Guards against the assertion above passing vacuously because the worker
  // ran everything sequentially.
  assert.equal(maxInflight, config.workerConcurrency);
});

test("a disabled endpoint and an endpoint whose URL is no longer safe are never sent to", async () => {
  const disabled = await seedDelivery(receiver.url("/ok"), { enabled: false });
  // A private-range address: rejected by URL safety even with the loopback
  // development exemption enabled.
  const unsafe = await seedDelivery("http://10.0.0.1/hook");

  await worker.runOnce();

  assert.equal(receiver.received.length, 0, "no request may leave the process for either delivery");

  for (const seeded of [disabled, unsafe]) {
    const delivery = await prisma.delivery.findUniqueOrThrow({ where: { id: seeded.deliveryId } });
    const attempts = await prisma.deliveryAttempt.findMany({ where: { deliveryId: seeded.deliveryId } });

    assert.equal(attempts.length, 0, "no request was made, so no attempt may be recorded");
    assert.equal(delivery.state, "FAILED");
    assert.notEqual(delivery.completedAt, null);
    assert.ok((delivery.failureReason ?? "").length > 0);
    assert.equal(delivery.failureReason?.includes(seeded.secret), false);
  }
});
