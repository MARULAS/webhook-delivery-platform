import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildServer } from "../src/app/server.ts";
import type { PrismaClient } from "../src/infrastructure/database/prisma.ts";
import { publishEvent } from "../src/modules/events/service.ts";
import { ConflictError } from "../src/shared/errors/app-error.ts";
import { createTestPrisma, ensureEventTypes, resetDatabase, testConfig } from "./helpers/test-db.ts";

/**
 * Integration tests for Part 3, against real Fastify and real PostgreSQL.
 *
 * These cover the acceptance criteria that only a real database can
 * demonstrate: the idempotency race, the atomicity of publication, the
 * subscription matching rule, and the absence of any outbound request from
 * the publishing path.
 */

const config = testConfig();
const prisma = createTestPrisma(config);
let app: FastifyInstance;

before(async () => {
  app = await buildServer(config, prisma);
  await ensureEventTypes(prisma, ["order.created", "order.completed"]);
});

beforeEach(async () => {
  await resetDatabase(prisma);
});

after(async () => {
  await app.close();
  await prisma.$disconnect();
});

async function createEndpoint(slug: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/endpoints",
    payload: { name: slug, url: `https://example.com/${slug}` },
  });
  assert.equal(response.statusCode, 201);
  return response.json().id as string;
}

async function subscribe(endpointId: string, eventType: string): Promise<void> {
  const response = await app.inject({
    method: "POST",
    url: `/endpoints/${endpointId}/subscriptions`,
    payload: { eventType },
  });
  assert.equal(response.statusCode, 201);
}

async function disableEndpoint(endpointId: string): Promise<void> {
  const response = await app.inject({
    method: "PATCH",
    url: `/endpoints/${endpointId}`,
    payload: { enabled: false },
  });
  assert.equal(response.statusCode, 200);
}

function publish(body: Record<string, unknown>, idempotencyKey?: string): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "POST",
    url: "/events",
    headers: idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey },
    payload: body,
  });
}

test("concurrent requests with the same Idempotency-Key produce exactly one event and exactly one delivery set", async () => {
  const endpointId = await createEndpoint("subscriber");
  await subscribe(endpointId, "order.created");

  const idempotencyKey = randomUUID();
  const body = { type: "order.created", payload: { orderId: 5821, amount: 1499 } };

  // Started without awaiting in between, so all six are genuinely in flight
  // together and race on the unique index rather than running in sequence.
  const responses = await Promise.all(Array.from({ length: 6 }, () => publish(body, idempotencyKey)));

  for (const response of responses) {
    assert.ok(response.statusCode < 500, `unexpected ${response.statusCode}: ${response.payload}`);
  }

  const eventIds = new Set(responses.map((response) => response.json().id as string));
  assert.equal(eventIds.size, 1, "every response must reference the same event");
  assert.equal(responses.filter((response) => response.statusCode === 201).length, 1, "exactly one winner");
  assert.equal(responses.filter((response) => response.statusCode === 200).length, 5, "the rest replay the original");

  assert.equal(await prisma.event.count(), 1);
  assert.equal(await prisma.delivery.count(), 1);
});

test("a replayed Idempotency-Key returns the original event, and reusing it for a different request is a 409 conflict", async () => {
  const endpointId = await createEndpoint("subscriber");
  await subscribe(endpointId, "order.created");

  const idempotencyKey = randomUUID();
  const first = await publish({ type: "order.created", payload: { orderId: 5821, amount: 1499 } }, idempotencyKey);
  assert.equal(first.statusCode, 201);
  const originalId = first.json().id as string;

  // Same request, and the same request with its JSON keys in another order:
  // both are replays of the original operation, not new events.
  for (const payload of [
    { orderId: 5821, amount: 1499 },
    { amount: 1499, orderId: 5821 },
  ]) {
    const replay = await publish({ type: "order.created", payload }, idempotencyKey);
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().id, originalId);
    assert.deepEqual(replay.json().payload, { orderId: 5821, amount: 1499 });
  }

  const differentPayload = await publish({ type: "order.created", payload: { orderId: 9999 } }, idempotencyKey);
  assert.equal(differentPayload.statusCode, 409);
  assert.equal(differentPayload.json().error.code, "CONFLICT");

  const differentType = await publish({ type: "order.completed", payload: { orderId: 5821, amount: 1499 } }, idempotencyKey);
  assert.equal(differentType.statusCode, 409);

  assert.equal(await prisma.event.count(), 1);
  assert.equal(await prisma.delivery.count(), 1);
});

test("publication creates one PENDING delivery per enabled subscribed endpoint and none for disabled or non-subscribing endpoints", async () => {
  const subscribed = await createEndpoint("enabled-subscriber");
  await subscribe(subscribed, "order.created");

  const disabled = await createEndpoint("disabled-subscriber");
  await subscribe(disabled, "order.created");
  await disableEndpoint(disabled);

  const otherType = await createEndpoint("non-subscriber");
  await subscribe(otherType, "order.completed");

  const response = await publish({ type: "order.created", payload: { orderId: 1 } });
  assert.equal(response.statusCode, 201);
  const eventId = response.json().id as string;

  const deliveries = await app.inject({ method: "GET", url: `/events/${eventId}/deliveries` });
  assert.equal(deliveries.statusCode, 200);
  const rows = deliveries.json() as { endpointId: string; state: string }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.endpointId, subscribed);
  assert.equal(rows[0]?.state, "PENDING");
  assert.doesNotMatch(deliveries.payload, /signingSecret/i);

  const fetched = await app.inject({ method: "GET", url: `/events/${eventId}` });
  assert.equal(fetched.statusCode, 200);
  assert.equal(fetched.json().type, "order.created");
  assert.deepEqual(fetched.json().payload, { orderId: 1 });

  assert.equal((await app.inject({ method: "GET", url: `/events/${randomUUID()}` })).statusCode, 404);
});

test("an event with no matching subscription is accepted and creates zero deliveries", async () => {
  const unrelated = await createEndpoint("unrelated");
  await subscribe(unrelated, "order.completed");

  const response = await publish({ type: "order.created", payload: { orderId: 2 } });
  assert.equal(response.statusCode, 201);

  assert.equal(await prisma.event.count(), 1);
  assert.equal(await prisma.delivery.count(), 0);
});

/**
 * Exercises the production transaction boundary rather than re-implementing
 * it: the real service runs against a client whose `$transaction` is the real
 * one, but whose transaction client fails on the fan-out insert — that is, a
 * failure after the event row has been written and before the delivery set is
 * complete.
 */
function clientFailingOnFanOut(real: PrismaClient, failure: Error): PrismaClient {
  const failingDeliveryCreateMany = (target: object): object =>
    proxyWith(target, (prop, value) => (prop === "createMany" ? () => Promise.reject(failure) : value));

  const failingTransactionClient = (tx: object): object =>
    proxyWith(tx, (prop, value) =>
      prop === "delivery" && typeof value === "object" && value !== null ? failingDeliveryCreateMany(value) : value,
    );

  return new Proxy(real, {
    get(target, prop) {
      if (prop === "$transaction") {
        const runTransaction = target.$transaction.bind(target) as (
          callback: (tx: object) => Promise<unknown>,
        ) => Promise<unknown>;
        return (callback: (tx: object) => Promise<unknown>) =>
          runTransaction((tx) => callback(failingTransactionClient(tx)));
      }
      return bound(target, prop);
    },
  });
}

function proxyWith(target: object, replace: (prop: string | symbol, value: unknown) => unknown): object {
  return new Proxy(target, {
    get(inner, prop) {
      return replace(prop, bound(inner, prop));
    },
  });
}

function bound(target: object, prop: string | symbol): unknown {
  const value = Reflect.get(target, prop) as unknown;
  return typeof value === "function" ? value.bind(target) : value;
}

test("a failure during fan-out rolls back the event insert, leaving no event and no partial delivery set", async () => {
  const endpointId = await createEndpoint("subscriber");
  await subscribe(endpointId, "order.created");

  const failure = new Error("induced fan-out failure");
  const failingClient = clientFailingOnFanOut(prisma, failure);

  await assert.rejects(
    () => publishEvent(failingClient, { type: "order.created", payload: { orderId: 3 } }),
    /induced fan-out failure/,
  );

  assert.equal(await prisma.event.count(), 0);
  assert.equal(await prisma.delivery.count(), 0);
});

/**
 * Reproduces the endpoint-deleted-during-publication window: the match
 * statement returns an endpoint that no longer exists by the time the fan-out
 * insert runs. Only the match result is substituted — the foreign key that
 * rejects it, and the rollback that follows, are the real ones.
 */
function clientMatchingMissingEndpoint(real: PrismaClient, missingEndpointId: string): PrismaClient {
  const matchWithMissingEndpoint = (subscription: object): object =>
    proxyWith(subscription, (prop, value) =>
      prop === "findMany" && typeof value === "function"
        ? async (args: unknown) => [
            ...(await (value as (a: unknown) => Promise<{ endpointId: string }[]>)(args)),
            { endpointId: missingEndpointId },
          ]
        : value,
    );

  const transactionClient = (tx: object): object =>
    proxyWith(tx, (prop, value) =>
      prop === "subscription" && typeof value === "object" && value !== null ? matchWithMissingEndpoint(value) : value,
    );

  return new Proxy(real, {
    get(target, prop) {
      if (prop === "$transaction") {
        const runTransaction = target.$transaction.bind(target) as (
          callback: (tx: object) => Promise<unknown>,
        ) => Promise<unknown>;
        return (callback: (tx: object) => Promise<unknown>) => runTransaction((tx) => callback(transactionClient(tx)));
      }
      return bound(target, prop);
    },
  });
}

test("an endpoint deleted while the event is being published is a conflict, not an unhandled failure, and leaves nothing behind", async () => {
  const endpointId = await createEndpoint("subscriber");
  await subscribe(endpointId, "order.created");

  await assert.rejects(
    () => publishEvent(clientMatchingMissingEndpoint(prisma, randomUUID()), { type: "order.created", payload: { orderId: 5 } }),
    (err: unknown) => err instanceof ConflictError && err.statusCode === 409,
  );

  assert.equal(await prisma.event.count(), 0);
  assert.equal(await prisma.delivery.count(), 0);
});

test("publication performs no outbound HTTP request", async () => {
  const endpointId = await createEndpoint("subscriber");
  await subscribe(endpointId, "order.created");

  const outboundCalls: string[] = [];
  const originalFetch = globalThis.fetch;
  const httpModule = http as unknown as { request: unknown };
  const httpsModule = https as unknown as { request: unknown };
  const originalHttpRequest = httpModule.request;
  const originalHttpsRequest = httpsModule.request;

  const record = (name: string) => () => {
    outboundCalls.push(name);
    throw new Error(`publication must not perform an outbound request (${name})`);
  };

  globalThis.fetch = record("fetch") as typeof globalThis.fetch;
  httpModule.request = record("http.request");
  httpsModule.request = record("https.request");

  try {
    const response = await publish({ type: "order.created", payload: { orderId: 4 } });
    assert.equal(response.statusCode, 201);
  } finally {
    globalThis.fetch = originalFetch;
    httpModule.request = originalHttpRequest;
    httpsModule.request = originalHttpsRequest;
  }

  assert.deepEqual(outboundCalls, []);
  assert.equal(await prisma.delivery.count(), 1);
});

test("an unknown event type and a malformed body are both rejected with 400 and persist nothing", async () => {
  const unknownType = await publish({ type: "no.such.type", payload: {} });
  assert.equal(unknownType.statusCode, 400);
  assert.equal(unknownType.json().error.code, "VALIDATION_ERROR");

  const malformed = [
    { payload: { orderId: 1 } },
    { type: "order.created" },
    { type: "", payload: {} },
    { type: "order.created", payload: "not an object" },
  ];
  for (const body of malformed) {
    const response = await publish(body);
    assert.equal(response.statusCode, 400, `expected 400 for ${JSON.stringify(body)}`);
  }

  const emptyIdempotencyKey = await publish({ type: "order.created", payload: {} }, "");
  assert.equal(emptyIdempotencyKey.statusCode, 400);

  assert.equal(await prisma.event.count(), 0);
});
