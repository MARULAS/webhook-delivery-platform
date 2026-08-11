import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerErrorHandling } from "../src/shared/errors/error-handler.ts";
import { NotFoundError } from "../src/shared/errors/app-error.ts";

function buildTestApp() {
  const app = Fastify({ logger: false });
  registerErrorHandling(app);

  app.get("/boom", () => {
    throw new Error("super secret internal detail that must never reach the client");
  });

  app.get("/missing-thing", () => {
    throw new NotFoundError("Widget not found.");
  });

  return app;
}

test("an unhandled error returns the shared 500 shape with no leaked internals", async () => {
  const app = buildTestApp();
  const response = await app.inject({ method: "GET", url: "/boom" });

  assert.equal(response.statusCode, 500);
  const body = response.json();
  assert.equal(body.error.code, "INTERNAL_ERROR");
  assert.equal(body.error.message, "Internal server error");
  assert.equal(typeof body.error.requestId, "string");
  assert.ok(body.error.requestId.length > 0);

  const raw = response.payload;
  assert.doesNotMatch(raw, /super secret internal detail/);
  assert.doesNotMatch(raw, /"stack"/);

  await app.close();
});

test("a thrown AppError subclass maps to its declared status code and shape", async () => {
  const app = buildTestApp();
  const response = await app.inject({ method: "GET", url: "/missing-thing" });

  assert.equal(response.statusCode, 404);
  const body = response.json();
  assert.deepEqual(body.error, {
    code: "NOT_FOUND",
    message: "Widget not found.",
    requestId: body.error.requestId,
  });

  await app.close();
});

test("an unmatched route returns 404 in the same shared error shape", async () => {
  const app = buildTestApp();
  const response = await app.inject({ method: "GET", url: "/no-such-route" });

  assert.equal(response.statusCode, 404);
  const body = response.json();
  assert.equal(body.error.code, "NOT_FOUND");
  assert.equal(typeof body.error.requestId, "string");

  await app.close();
});
