import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";
import Fastify from "fastify";
import { claimPendingDeliveries } from "../src/worker/delivery-claiming.ts";
import { recoverExpiredLeases, stuckDeliveryClaimCeiling } from "../src/worker/lease-recovery.ts";
import { createDeliveryWorker } from "../src/worker/delivery-worker.ts";
import {
  completeDeliveryWithAttempt,
  failDeliveryWithoutAttempt,
} from "../src/modules/deliveries/state-transitions.ts";
import { createTestPrisma, ensureEventTypes, resetDatabase, testConfig } from "./helpers/test-db.ts";
import { startTestReceiver, type TestReceiver } from "./helpers/test-receiver.ts";

/**
 * Part 5 integration tests: the retry lifecycle, lease recovery, the fencing
 * that stops a stale worker from overwriting a newer state, and graceful
 * shutdown. Real PostgreSQL, a real local receiver, and no sleeping on the
 * retry clock — due times and lease expiries are written straight into the
 * database, which is where they live anyway.
 */

const EVENT_TYPE = "order.completed";
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 1000;

const config = testConfig({
  ALLOW_LOCAL_ENDPOINTS: "true",
  WORKER_ENABLED: "false",
  WORKER_CONCURRENCY: "2",
  WORKER_BATCH_SIZE: "10",
  DELIVERY_TIMEOUT_MS: "300",
  MAX_DELIVERY_ATTEMPTS: String(MAX_ATTEMPTS),
  RETRY_BASE_DELAY_MS: String(BASE_DELAY_MS),
  RETRY_MAX_DELAY_MS: "60000",
});

const prisma = createTestPrisma(config);
const logger = Fastify({ logger: false }).log;
const worker = createDeliveryWorker(prisma, config, logger);

let receiver: TestReceiver;
let eventTypeId: string;
/** Responses held open until a test releases them; see the /gate path. */
let gated: ServerResponse[] = [];

before(async () => {
  receiver = await startTestReceiver((request, res) => {
    if (request.path === "/error") {
      res.writeHead(500).end();
      return;
    }
    if (request.path === "/gone") {
      res.writeHead(404).end();
      return;
    }
    if (request.path === "/gate") {
      gated.push(res);
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
  releaseGated();
});

after(async () => {
  releaseGated();
  await receiver.close();
  await prisma.$disconnect();
});

function releaseGated(): void {
  for (const res of gated) {
    res.writeHead(200).end();
  }
  gated = [];
}

interface SeededDelivery {
  deliveryId: string;
  endpointId: string;
  secret: string;
}

async function seedDelivery(
  url: string,
  overrides: { attemptCount?: number } = {},
): Promise<SeededDelivery> {
  const secret = randomBytes(32).toString("hex");
  const endpoint = await prisma.webhookEndpoint.create({
    data: { name: "test receiver", url, signingSecret: secret },
  });
  const event = await prisma.event.create({
    data: { eventTypeId, payload: { orderId: 5821 } },
  });
  const delivery = await prisma.delivery.create({
    data: { eventId: event.id, endpointId: endpoint.id, attemptCount: overrides.attemptCount ?? 0 },
  });
  return { deliveryId: delivery.id, endpointId: endpoint.id, secret };
}

/** Time travel without sleeping: bring a scheduled retry forward to the past. */
async function makeRetryDue(deliveryId: string): Promise<void> {
  await prisma.delivery.update({
    where: { id: deliveryId },
    data: { nextAttemptAt: new Date(Date.now() - 60_000) },
  });
}

/** Leaves the delivery looking exactly like one whose worker died mid-flight. */
async function strandInProcessing(deliveryId: string, leaseOffsetMs: number): Promise<void> {
  const now = Date.now();
  await prisma.delivery.update({
    where: { id: deliveryId },
    data: {
      state: "PROCESSING",
      claimedAt: new Date(now - 120_000),
      leaseUntil: new Date(now + leaseOffsetMs),
      nextAttemptAt: null,
    },
  });
}

async function delayMs(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("condition was not met within the timeout");
    }
    await delayMs(5);
  }
}

test("a retryable failure schedules a retry at the policy's due time instead of completing the delivery", async () => {
  const seeded = await seedDelivery(receiver.url("/error"));

  await worker.runOnce();

  const delivery = await prisma.delivery.findUniqueOrThrow({ where: { id: seeded.deliveryId } });
  const attempts = await prisma.deliveryAttempt.findMany({ where: { deliveryId: seeded.deliveryId } });

  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]!.outcome, "RETRYABLE_FAILURE");
  assert.equal(delivery.state, "RETRY_SCHEDULED");
  assert.equal(delivery.completedAt, null, "a scheduled retry is not a completed delivery");
  assert.equal(delivery.failureReason, null);
  assert.notEqual(delivery.nextAttemptAt, null);

  // The persisted due time is the policy's, measured from the attempt: one
  // base delay, not two (a wrong exponent) and not zero (no backoff at all).
  const scheduledDelay = delivery.nextAttemptAt!.getTime() - attempts[0]!.attemptedAt.getTime();
  assert.ok(
    scheduledDelay >= BASE_DELAY_MS && scheduledDelay < BASE_DELAY_MS * 1.5,
    `retry was scheduled ${scheduledDelay}ms after the attempt, expected about ${BASE_DELAY_MS}ms`,
  );
});

test("the retry due time is written on the database clock, not this process's clock", async () => {
  const seeded = await seedDelivery(receiver.url("/error"));

  // The claim decides "is this retry due?" on the database clock, so the due
  // time has to be written on that same clock. Skewing only this process's
  // clock forward makes the two sources distinguishable: a due time taken from
  // `new Date()` here would land an hour out, and the backoff of a real
  // deployment whose clocks disagree would be wrong by the same amount.
  const RealDate = Date;
  const SKEW_MS = 3_600_000;
  const SkewedDate = class extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) {
        super(RealDate.now() + SKEW_MS);
        return;
      }
      super(...(args as [number]));
    }
    static override now(): number {
      return RealDate.now() + SKEW_MS;
    }
  } as DateConstructor;

  const attemptedAt = new RealDate();
  const [claimed] = await claimPendingDeliveries(prisma, {
    batchSize: 1,
    leaseMs: config.deliveryLeaseMs,
  });

  globalThis.Date = SkewedDate;
  let result;
  try {
    result = await completeDeliveryWithAttempt(
      prisma,
      seeded.deliveryId,
      {
        attemptNumber: claimed!.attemptNumber,
        attemptedAt,
        outcome: "RETRYABLE_FAILURE",
        httpStatusCode: 500,
        durationMs: 4,
        errorCategory: "HTTP_STATUS",
        errorMessage: "Receiver responded with HTTP 500.",
      },
      config,
    );
  } finally {
    globalThis.Date = RealDate;
  }

  assert.equal(result.state, "RETRY_SCHEDULED");
  const delivery = await prisma.delivery.findUniqueOrThrow({ where: { id: seeded.deliveryId } });
  const scheduledIn = delivery.nextAttemptAt!.getTime() - RealDate.now();
  assert.ok(
    scheduledIn > 0 && scheduledIn < BASE_DELAY_MS * 1.5,
    `retry was scheduled ${scheduledIn}ms out; the skewed process clock leaked into the due time`,
  );
});

test("a non-retryable failure fails immediately without spending the retry budget", async () => {
  const seeded = await seedDelivery(receiver.url("/gone"));

  await worker.runOnce();

  const delivery = await prisma.delivery.findUniqueOrThrow({ where: { id: seeded.deliveryId } });
  const attempts = await prisma.deliveryAttempt.findMany({ where: { deliveryId: seeded.deliveryId } });

  assert.equal(attempts.length, 1, "one attempt made, of a budget of three");
  assert.equal(attempts[0]!.outcome, "PERMANENT_FAILURE");
  assert.equal(delivery.state, "FAILED");
  assert.notEqual(delivery.completedAt, null);
  assert.equal(delivery.nextAttemptAt, null, "no retry may be scheduled for a permanent failure");
  assert.equal(delivery.failureReason, attempts[0]!.errorMessage);

  // Nothing schedules it again: the budget was never the reason it stopped.
  assert.equal(await worker.runOnce(), 0);
  assert.equal(receiver.received.length, 1);
});

test("the terminal decision follows persisted attempt rows, not Delivery.attemptCount", async () => {
  // Both deliveries carry an attemptCount far above the budget — the state a
  // delivery reaches after many claims that never sent a request. They differ
  // only in how many attempts were actually persisted.
  const noHistory = await seedDelivery(receiver.url("/error"), { attemptCount: 50 });
  const withHistory = await seedDelivery(receiver.url("/error"), { attemptCount: 50 });

  await prisma.deliveryAttempt.createMany({
    data: [20, 21].map((attemptNumber) => ({
      deliveryId: withHistory.deliveryId,
      attemptNumber,
      attemptedAt: new Date(Date.now() - 60_000),
      outcome: "RETRYABLE_FAILURE" as const,
      httpStatusCode: 500,
      durationMs: 5,
      errorCategory: "HTTP_STATUS" as const,
      errorMessage: "Receiver responded with HTTP 500.",
    })),
  });

  await worker.runOnce();

  const first = await prisma.delivery.findUniqueOrThrow({ where: { id: noHistory.deliveryId } });
  const second = await prisma.delivery.findUniqueOrThrow({ where: { id: withHistory.deliveryId } });

  assert.equal(
    first.state,
    "RETRY_SCHEDULED",
    "attemptCount 51 is far past the budget, but only one request was ever made",
  );
  assert.equal(
    second.state,
    "FAILED",
    "two persisted attempts plus this one exhaust a budget of three",
  );
  // Identical attemptCount, opposite outcomes: the decision cannot be reading
  // that column.
  assert.equal(first.attemptCount, second.attemptCount);
  assert.equal(await prisma.deliveryAttempt.count({ where: { deliveryId: withHistory.deliveryId } }), 3);
});

test("exhausting the attempt budget ends in FAILED with a completion timestamp, and it is never claimed again", async () => {
  const seeded = await seedDelivery(receiver.url("/error"));
  const scheduledDelays: number[] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const claimed = await worker.runOnce();
    assert.equal(claimed, 1, `attempt ${attempt} should have been claimed`);

    const delivery = await prisma.delivery.findUniqueOrThrow({ where: { id: seeded.deliveryId } });
    if (attempt < MAX_ATTEMPTS) {
      assert.equal(delivery.state, "RETRY_SCHEDULED");
      const attempts = await prisma.deliveryAttempt.findMany({
        where: { deliveryId: seeded.deliveryId },
        orderBy: { attemptNumber: "desc" },
        take: 1,
      });
      scheduledDelays.push(delivery.nextAttemptAt!.getTime() - attempts[0]!.attemptedAt.getTime());
      await makeRetryDue(seeded.deliveryId);
    }
  }

  // The delay grew between retries rather than staying flat.
  assert.equal(scheduledDelays.length, MAX_ATTEMPTS - 1);
  assert.ok(
    scheduledDelays[1]! >= scheduledDelays[0]! * 1.8,
    `delays did not grow: ${scheduledDelays.join(", ")}`,
  );

  const delivery = await prisma.delivery.findUniqueOrThrow({ where: { id: seeded.deliveryId } });
  assert.equal(delivery.state, "FAILED");
  assert.notEqual(delivery.completedAt, null);
  assert.equal(delivery.nextAttemptAt, null);
  assert.ok((delivery.failureReason ?? "").includes(String(MAX_ATTEMPTS)));
  assert.equal(delivery.failureReason?.includes(seeded.secret), false);
  assert.equal(await prisma.deliveryAttempt.count({ where: { deliveryId: seeded.deliveryId } }), MAX_ATTEMPTS);

  // No further automatic attempt, even after the poll that would have found it.
  assert.equal(await worker.runOnce(), 0);
  assert.equal(receiver.received.length, MAX_ATTEMPTS);
});

test("a retry that is not yet due is skipped while a due one is claimed", async () => {
  const due = await seedDelivery(receiver.url("/ok"));
  const notDue = await seedDelivery(receiver.url("/ok"));

  await prisma.delivery.update({
    where: { id: due.deliveryId },
    data: { state: "RETRY_SCHEDULED", nextAttemptAt: new Date(Date.now() - 1000) },
  });
  await prisma.delivery.update({
    where: { id: notDue.deliveryId },
    data: { state: "RETRY_SCHEDULED", nextAttemptAt: new Date(Date.now() + 3_600_000) },
  });

  assert.equal(await worker.runOnce(), 1);

  assert.equal(receiver.received.length, 1);
  const delivered = await prisma.delivery.findUniqueOrThrow({ where: { id: due.deliveryId } });
  const waiting = await prisma.delivery.findUniqueOrThrow({ where: { id: notDue.deliveryId } });
  assert.equal(delivered.state, "DELIVERED");
  assert.equal(waiting.state, "RETRY_SCHEDULED");
  assert.equal(waiting.attemptCount, 0, "a claim would have minted an attempt number");
  assert.notEqual(waiting.nextAttemptAt, null);
});

test("a scheduled retry survives a process restart and is picked up at its due time", async () => {
  const seeded = await seedDelivery(receiver.url("/error"));
  await worker.runOnce();
  assert.equal(
    (await prisma.delivery.findUniqueOrThrow({ where: { id: seeded.deliveryId } })).state,
    "RETRY_SCHEDULED",
  );

  // A restart: a brand-new client and worker, with nothing carried over from
  // the objects above. The schedule lives in PostgreSQL, not in this process.
  const restartedPrisma = createTestPrisma(config);
  const restartedWorker = createDeliveryWorker(restartedPrisma, config, logger);

  try {
    assert.equal(await restartedWorker.runOnce(), 0, "the retry is not due yet");
    assert.equal(receiver.received.length, 1);

    // The receiver recovers, and the due time arrives.
    await prisma.webhookEndpoint.update({
      where: { id: seeded.endpointId },
      data: { url: receiver.url("/ok") },
    });
    await makeRetryDue(seeded.deliveryId);

    assert.equal(await restartedWorker.runOnce(), 1);
  } finally {
    await restartedPrisma.$disconnect();
  }

  const delivery = await prisma.delivery.findUniqueOrThrow({ where: { id: seeded.deliveryId } });
  const attempts = await prisma.deliveryAttempt.findMany({
    where: { deliveryId: seeded.deliveryId },
    orderBy: { attemptNumber: "asc" },
  });
  assert.equal(delivery.state, "DELIVERED");
  assert.equal(attempts.length, 2, "the pre-restart attempt is still part of the history");
  assert.equal(attempts[0]!.outcome, "RETRYABLE_FAILURE");
  assert.equal(attempts[1]!.outcome, "SUCCESS");
});

test("an expired lease is recovered while a live one is left alone, and neither loses history", async () => {
  const expired = await seedDelivery(receiver.url("/ok"), { attemptCount: 4 });
  const live = await seedDelivery(receiver.url("/ok"), { attemptCount: 4 });

  for (const seeded of [expired, live]) {
    await prisma.deliveryAttempt.create({
      data: {
        deliveryId: seeded.deliveryId,
        attemptNumber: 4,
        attemptedAt: new Date(Date.now() - 60_000),
        outcome: "RETRYABLE_FAILURE",
        httpStatusCode: 500,
        durationMs: 7,
        errorCategory: "HTTP_STATUS",
        errorMessage: "Receiver responded with HTTP 500.",
      },
    });
  }

  await strandInProcessing(expired.deliveryId, -1000);
  await strandInProcessing(live.deliveryId, 3_600_000);

  assert.deepEqual(await recoverExpiredLeases(prisma, { batchSize: 10, maxDeliveryAttempts: MAX_ATTEMPTS }), {
    recovered: 1,
    abandoned: 0,
  });

  const recovered = await prisma.delivery.findUniqueOrThrow({ where: { id: expired.deliveryId } });
  assert.equal(recovered.state, "RETRY_SCHEDULED");
  assert.ok(recovered.nextAttemptAt !== null && recovered.nextAttemptAt.getTime() <= Date.now() + 1000);
  assert.equal(recovered.attemptCount, 4, "recovery must not mint or consume an attempt number");
  assert.equal(await prisma.deliveryAttempt.count({ where: { deliveryId: expired.deliveryId } }), 1);

  const held = await prisma.delivery.findUniqueOrThrow({ where: { id: live.deliveryId } });
  assert.equal(held.state, "PROCESSING", "a delivery a live worker still holds must not be reclaimed");
  assert.equal(held.nextAttemptAt, null);
  assert.equal(held.attemptCount, 4);
});

test("a delivery stranded mid-processing is recovered, and its earlier attempts still count toward the budget", async () => {
  const seeded = await seedDelivery(receiver.url("/error"));

  // One real attempt, then the worker dies before the next one completes.
  await worker.runOnce();
  assert.equal(await prisma.deliveryAttempt.count({ where: { deliveryId: seeded.deliveryId } }), 1);
  await strandInProcessing(seeded.deliveryId, -1000);

  // The sweep runs before the claim in the same iteration, so a recovered
  // delivery is picked up immediately rather than a poll interval later.
  assert.equal(await worker.runOnce(), 1);

  let delivery = await prisma.delivery.findUniqueOrThrow({ where: { id: seeded.deliveryId } });
  let attempts = await prisma.deliveryAttempt.findMany({
    where: { deliveryId: seeded.deliveryId },
    orderBy: { attemptNumber: "asc" },
  });
  assert.equal(delivery.state, "RETRY_SCHEDULED", "two of three attempts made");
  assert.equal(attempts.length, 2, "the pre-crash attempt is retained");

  await makeRetryDue(seeded.deliveryId);
  await worker.runOnce();

  delivery = await prisma.delivery.findUniqueOrThrow({ where: { id: seeded.deliveryId } });
  attempts = await prisma.deliveryAttempt.findMany({ where: { deliveryId: seeded.deliveryId } });
  assert.equal(
    delivery.state,
    "FAILED",
    "the attempt made before the crash counted toward the budget of three",
  );
  assert.equal(attempts.length, MAX_ATTEMPTS);
  assert.equal(new Set(attempts.map((a) => a.attemptNumber)).size, MAX_ATTEMPTS);
});

test("a delivery claimed far more often than its budget could justify is abandoned rather than swept forever", async () => {
  // The loop this bounds: the request reaches the receiver, the transaction
  // that would record it fails, so no attempt row is committed and the budget
  // — a count of those rows — never moves. Only the claim counter survives
  // that failure, so only the claim counter can bound it.
  const ceiling = stuckDeliveryClaimCeiling(MAX_ATTEMPTS);
  const stuck = await seedDelivery(receiver.url("/ok"), { attemptCount: ceiling });
  const recoverable = await seedDelivery(receiver.url("/ok"), { attemptCount: ceiling - 1 });

  await strandInProcessing(stuck.deliveryId, -1000);
  await strandInProcessing(recoverable.deliveryId, -1000);

  assert.deepEqual(
    await recoverExpiredLeases(prisma, { batchSize: 10, maxDeliveryAttempts: MAX_ATTEMPTS }),
    { recovered: 1, abandoned: 1 },
  );

  const abandoned = await prisma.delivery.findUniqueOrThrow({ where: { id: stuck.deliveryId } });
  assert.equal(abandoned.state, "FAILED");
  assert.notEqual(abandoned.completedAt, null);
  assert.equal(abandoned.nextAttemptAt, null);
  assert.ok((abandoned.failureReason ?? "").length > 0);
  assert.equal(abandoned.failureReason?.includes(stuck.secret), false);

  // One claim below the ceiling is still ordinary recovery: the allowance must
  // never interfere with a delivery that is merely unlucky.
  const recovered = await prisma.delivery.findUniqueOrThrow({ where: { id: recoverable.deliveryId } });
  assert.equal(recovered.state, "RETRY_SCHEDULED");
  assert.notEqual(recovered.nextAttemptAt, null);

  // And the abandoned one is terminal: nothing claims it again.
  assert.equal(await worker.runOnce(), 1, "only the recovered delivery is eligible");
  assert.equal(
    (await prisma.delivery.findUniqueOrThrow({ where: { id: stuck.deliveryId } })).state,
    "FAILED",
  );
});

test("stopping between the recovery sweep and the claim leaves no batch stranded", async () => {
  const stranded = await seedDelivery(receiver.url("/ok"));
  await strandInProcessing(stranded.deliveryId, -1000);
  const pending = await seedDelivery(receiver.url("/ok"));

  // A signal arriving mid-iteration: the sweep has run, the claim has not.
  const stoppingWorker = createDeliveryWorker(prisma, config, logger);
  stoppingWorker.stop();
  assert.equal(await stoppingWorker.runOnce(), 0);

  // Nothing was claimed, so nothing sits in PROCESSING with a fresh lease that
  // no worker will start — the failure that would make every clean shutdown
  // cost a lease period.
  const untouched = await prisma.delivery.findUniqueOrThrow({ where: { id: pending.deliveryId } });
  assert.equal(untouched.state, "PENDING");
  assert.equal(untouched.attemptCount, 0);
  assert.equal(receiver.received.length, 0);

  // The sweep still ran: stopping suppresses new work, not recovery of old.
  assert.equal(
    (await prisma.delivery.findUniqueOrThrow({ where: { id: stranded.deliveryId } })).state,
    "RETRY_SCHEDULED",
  );
});

test("a recovery sweep and a claim running in parallel never hand the same delivery to two owners", async () => {
  const seeded: SeededDelivery[] = [];
  for (let i = 0; i < 6; i += 1) {
    const delivery = await seedDelivery(receiver.url("/ok"));
    await strandInProcessing(delivery.deliveryId, -1000);
    seeded.push(delivery);
  }

  // Separate clients so these are genuinely separate PostgreSQL sessions
  // rather than being serialized onto one pooled connection.
  const clientA = createTestPrisma(config);
  const clientB = createTestPrisma(config);

  try {
    const [, claimA, , claimB] = await Promise.all([
      recoverExpiredLeases(clientA, { batchSize: 10, maxDeliveryAttempts: MAX_ATTEMPTS }),
      claimPendingDeliveries(clientA, { batchSize: 10, leaseMs: config.deliveryLeaseMs }),
      recoverExpiredLeases(clientB, { batchSize: 10, maxDeliveryAttempts: MAX_ATTEMPTS }),
      claimPendingDeliveries(clientB, { batchSize: 10, leaseMs: config.deliveryLeaseMs }),
    ]);

    const idsA = claimA.map((claim) => claim.id);
    const idsB = claimB.map((claim) => claim.id);
    assert.equal(new Set(idsA).size, idsA.length, "one claim returned a duplicate row");
    assert.equal(new Set(idsB).size, idsB.length, "one claim returned a duplicate row");
    for (const id of idsB) {
      assert.equal(idsA.includes(id), false, "the same delivery was claimed twice");
    }

    // The decisive check: a row taken by two owners would have been
    // incremented twice. Every claimed row must sit at exactly one.
    for (const delivery of await prisma.delivery.findMany()) {
      assert.ok(
        delivery.attemptCount <= 1,
        `delivery ${delivery.id} was claimed ${delivery.attemptCount} times`,
      );
      if (delivery.attemptCount === 1) {
        assert.equal(delivery.state, "PROCESSING");
      }
    }
  } finally {
    await clientA.$disconnect();
    await clientB.$disconnect();
  }
});

test("a stale worker cannot overwrite the state of a delivery that changed hands, but its attempt is still recorded", async () => {
  const seeded = await seedDelivery(receiver.url("/ok"));

  const [stale] = await claimPendingDeliveries(prisma, {
    batchSize: 1,
    leaseMs: config.deliveryLeaseMs,
  });
  assert.equal(stale!.attemptNumber, 1);

  // The stale worker's lease expires while its request is still in flight, and
  // the delivery is recovered and re-claimed by a new owner.
  await prisma.delivery.update({
    where: { id: seeded.deliveryId },
    data: { leaseUntil: new Date(Date.now() - 1000) },
  });
  assert.deepEqual(await recoverExpiredLeases(prisma, { batchSize: 10, maxDeliveryAttempts: MAX_ATTEMPTS }), {
    recovered: 1,
    abandoned: 0,
  });
  const [current] = await claimPendingDeliveries(prisma, {
    batchSize: 1,
    leaseMs: config.deliveryLeaseMs,
  });
  assert.equal(current!.attemptNumber, 2, "the new owner holds a fresh fencing token");

  // Now the stale worker finishes and tries to write its outcome.
  const staleResult = await completeDeliveryWithAttempt(
    prisma,
    seeded.deliveryId,
    {
      attemptNumber: stale!.attemptNumber,
      attemptedAt: new Date(Date.now() - 5000),
      outcome: "SUCCESS",
      httpStatusCode: 200,
      durationMs: 12,
      errorCategory: null,
      errorMessage: null,
    },
    config,
  );

  assert.equal(staleResult.applied, false);
  assert.equal(staleResult.state, null);

  let delivery = await prisma.delivery.findUniqueOrThrow({ where: { id: seeded.deliveryId } });
  assert.equal(delivery.state, "PROCESSING", "the new owner's state was not overwritten");
  assert.equal(delivery.completedAt, null);
  assert.equal(delivery.attemptCount, 2);

  // History is not silently dropped: the request really was sent.
  const staleAttempt = await prisma.deliveryAttempt.findFirstOrThrow({
    where: { deliveryId: seeded.deliveryId, attemptNumber: 1 },
  });
  assert.equal(staleAttempt.outcome, "SUCCESS");

  // A stale abandonment writes nothing at all and does not throw.
  const staleAbandon = await failDeliveryWithoutAttempt(
    prisma,
    seeded.deliveryId,
    stale!.attemptNumber,
    "Endpoint was disabled before the delivery was attempted.",
  );
  assert.equal(staleAbandon.applied, false);
  assert.equal(
    (await prisma.delivery.findUniqueOrThrow({ where: { id: seeded.deliveryId } })).state,
    "PROCESSING",
  );

  // The current owner's transition still applies normally.
  const currentResult = await completeDeliveryWithAttempt(
    prisma,
    seeded.deliveryId,
    {
      attemptNumber: current!.attemptNumber,
      attemptedAt: new Date(),
      outcome: "SUCCESS",
      httpStatusCode: 200,
      durationMs: 9,
      errorCategory: null,
      errorMessage: null,
    },
    config,
  );
  assert.equal(currentResult.applied, true);
  assert.equal(currentResult.state, "DELIVERED");

  delivery = await prisma.delivery.findUniqueOrThrow({ where: { id: seeded.deliveryId } });
  assert.equal(delivery.state, "DELIVERED");
  assert.equal(await prisma.deliveryAttempt.count({ where: { deliveryId: seeded.deliveryId } }), 2);
});

test("after stop() the worker starts no further deliveries and the drain finishes inside its bound", async () => {
  const shutdownConfig = testConfig({
    ALLOW_LOCAL_ENDPOINTS: "true",
    WORKER_ENABLED: "false",
    WORKER_CONCURRENCY: "2",
    WORKER_BATCH_SIZE: "10",
    WORKER_POLL_INTERVAL_MS: "20",
    DELIVERY_TIMEOUT_MS: "5000",
    WORKER_SHUTDOWN_GRACE_MS: "2000",
  });
  const shutdownWorker = createDeliveryWorker(prisma, shutdownConfig, logger);

  const seeded: SeededDelivery[] = [];
  for (let i = 0; i < 4; i += 1) {
    seeded.push(await seedDelivery(receiver.url("/gate")));
  }

  shutdownWorker.start();
  // The pool fills to its limit of two and blocks there; the other two
  // deliveries are claimed but not yet started.
  await waitFor(() => gated.length === 2);

  shutdownWorker.stop();
  releaseGated();

  const startedAt = Date.now();
  const drained = await shutdownWorker.drain(shutdownConfig.workerShutdownGraceMs);
  const drainMs = Date.now() - startedAt;

  assert.equal(drained, true, "in-flight work should finish well inside the grace window");
  assert.ok(drainMs <= shutdownConfig.workerShutdownGraceMs, `drain took ${drainMs}ms`);

  assert.equal(
    receiver.received.length,
    2,
    "the pool must not start deliveries it had not begun once stopping",
  );

  const states = await prisma.delivery.findMany({ where: { id: { in: seeded.map((s) => s.deliveryId) } } });
  const delivered = states.filter((delivery) => delivery.state === "DELIVERED");
  const stranded = states.filter((delivery) => delivery.state === "PROCESSING");
  assert.equal(delivered.length, 2);
  // Intended: these keep their lease and are recovered by the sweep, because
  // correctness never depends on shutdown succeeding.
  assert.equal(stranded.length, 2);
  assert.equal(await prisma.deliveryAttempt.count({ where: { deliveryId: { in: stranded.map((d) => d.id) } } }), 0);

  // Nothing is claimed after stop(), including work that arrives afterwards.
  const late = await seedDelivery(receiver.url("/ok"));
  await delayMs(shutdownConfig.workerPollIntervalMs * 5);
  assert.equal(
    (await prisma.delivery.findUniqueOrThrow({ where: { id: late.deliveryId } })).state,
    "PENDING",
  );
});
