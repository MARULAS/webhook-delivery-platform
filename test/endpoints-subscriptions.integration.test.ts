import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/app/server.ts";
import { createTestPrisma, ensureEventTypes, resetDatabase, testConfig } from "./helpers/test-db.ts";

/**
 * Integration tests against a real PostgreSQL database (see
 * test/helpers/test-db.ts). Covers the Part 2 acceptance criteria that
 * cannot be verified by the pure url-safety unit tests: secret absence from
 * every endpoint response shape, and the duplicate-subscription database
 * constraint under genuine concurrency.
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

async function createEndpoint(url = "https://example.com/hook"): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/endpoints",
    payload: { name: "Test endpoint", url },
  });
  assert.equal(response.statusCode, 201);
  return response.json().id as string;
}

test("creating an endpoint returns 201 with no signingSecret key anywhere in the response", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/endpoints",
    payload: { name: "Test endpoint", url: "https://example.com/hook" },
  });

  assert.equal(response.statusCode, 201);
  const body = response.json();
  assert.deepEqual(Object.keys(body).sort(), ["createdAt", "enabled", "id", "name", "updatedAt", "url"]);
  assert.doesNotMatch(response.payload, /signingSecret/i);
});

test("get, list, and update endpoint responses never include the signing secret", async () => {
  const id = await createEndpoint();

  const get = await app.inject({ method: "GET", url: `/endpoints/${id}` });
  assert.equal(get.statusCode, 200);
  assert.ok(!("signingSecret" in get.json()));
  assert.doesNotMatch(get.payload, /signingSecret/i);

  const list = await app.inject({ method: "GET", url: "/endpoints" });
  assert.equal(list.statusCode, 200);
  const items = list.json() as Record<string, unknown>[];
  assert.ok(items.length > 0);
  for (const item of items) {
    assert.ok(!("signingSecret" in item));
  }
  assert.doesNotMatch(list.payload, /signingSecret/i);

  const update = await app.inject({
    method: "PATCH",
    url: `/endpoints/${id}`,
    payload: { enabled: false },
  });
  assert.equal(update.statusCode, 200);
  assert.equal(update.json().enabled, false);
  assert.ok(!("signingSecret" in update.json()));
  assert.doesNotMatch(update.payload, /signingSecret/i);
});

test("creating an endpoint with an unsafe URL returns 400 with a security-category error and persists nothing", async () => {
  const unsafeUrls = [
    "file:///etc/passwd",
    "http://localhost:3000/hook",
    "http://127.0.0.1:3000/hook",
    "http://10.0.0.5/hook",
    "http://169.254.169.254/hook",
    "not a url",
  ];

  for (const url of unsafeUrls) {
    const response = await app.inject({
      method: "POST",
      url: "/endpoints",
      payload: { name: "bad", url },
    });
    assert.equal(response.statusCode, 400, `expected 400 for ${url}`);
    assert.equal(response.json().error.code, "SECURITY_ERROR", `expected SECURITY_ERROR for ${url}`);
  }

  assert.equal(await prisma.webhookEndpoint.count(), 0);
});

test("the D5 development flag allows a loopback endpoint URL end-to-end, off by default", async () => {
  const devConfigWithLocal = testConfig({ ALLOW_LOCAL_ENDPOINTS: "true", NODE_ENV: "development" });
  const localApp = await buildServer(devConfigWithLocal, prisma);
  try {
    const response = await localApp.inject({
      method: "POST",
      url: "/endpoints",
      payload: { name: "local receiver", url: "http://127.0.0.1:4000/hook" },
    });
    assert.equal(response.statusCode, 201);
  } finally {
    await localApp.close();
  }

  // The default app (flag off) still rejects the same URL.
  const response = await app.inject({
    method: "POST",
    url: "/endpoints",
    payload: { name: "local receiver", url: "http://127.0.0.1:4000/hook" },
  });
  assert.equal(response.statusCode, 400);
});

test("deleting an endpoint cascades to delete its subscriptions", async () => {
  const id = await createEndpoint();
  const sub = await app.inject({
    method: "POST",
    url: `/endpoints/${id}/subscriptions`,
    payload: { eventType: "order.created" },
  });
  assert.equal(sub.statusCode, 201);

  const del = await app.inject({ method: "DELETE", url: `/endpoints/${id}` });
  assert.equal(del.statusCode, 204);

  assert.equal(await prisma.subscription.count(), 0);
});

test("a subscription referencing an unknown event type returns 400", async () => {
  const id = await createEndpoint();
  const response = await app.inject({
    method: "POST",
    url: `/endpoints/${id}/subscriptions`,
    payload: { eventType: "no.such.type" },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "VALIDATION_ERROR");
  assert.equal(await prisma.subscription.count(), 0);
});

test("a duplicate subscription for the same endpoint and event type is rejected by the database constraint under concurrent requests", async () => {
  const id = await createEndpoint();

  const [first, second] = await Promise.all([
    app.inject({
      method: "POST",
      url: `/endpoints/${id}/subscriptions`,
      payload: { eventType: "order.created" },
    }),
    app.inject({
      method: "POST",
      url: `/endpoints/${id}/subscriptions`,
      payload: { eventType: "order.created" },
    }),
  ]);

  const statusCodes = [first.statusCode, second.statusCode].sort();
  assert.deepEqual(statusCodes, [201, 409]);

  const conflict = first.statusCode === 409 ? first : second;
  assert.equal(conflict.json().error.code, "CONFLICT");

  assert.equal(await prisma.subscription.count({ where: { endpointId: id } }), 1);
});
