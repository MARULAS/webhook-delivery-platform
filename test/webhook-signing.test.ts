import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  buildSignedWebhookRequest,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
} from "../src/infrastructure/security/signing.ts";

/**
 * Protects the serialize-once rule: the bytes that are signed must be the
 * bytes that are sent. The integration suite verifies the same signature
 * against what a receiver actually received; this asserts the construction
 * itself, independently recomputed the way a receiver would.
 */

const SECRET = "6f4b1c9d2e8a7f30b5c1d4e9a2f87b60";

test("the signature is HMAC-SHA256 over the timestamp and the exact bytes returned as the body", () => {
  const sentAt = new Date("2026-08-12T10:11:12.500Z");

  const signed = buildSignedWebhookRequest(
    { type: "order.completed", payload: { orderId: 5821, amount: 1499 } },
    SECRET,
    sentAt,
  );

  // Whole seconds, truncated — not rounded up from the .500 fraction.
  const timestamp = String(Math.floor(sentAt.getTime() / 1000));
  assert.equal(signed.headers[TIMESTAMP_HEADER], timestamp);

  const expected = createHmac("sha256", SECRET)
    .update(`${timestamp}.`)
    .update(signed.body)
    .digest("hex");

  assert.equal(signed.headers[SIGNATURE_HEADER], `sha256=${expected}`);

  // The timestamp is part of the signed message, so altering it invalidates
  // the signature rather than merely accompanying it.
  const forged = createHmac("sha256", SECRET)
    .update(`${Number(timestamp) + 1}.`)
    .update(signed.body)
    .digest("hex");
  assert.notEqual(forged, expected);
});

test("signing puts the endpoint secret in neither the body nor any header", () => {
  const signed = buildSignedWebhookRequest({ payload: { a: 1 } }, SECRET, new Date());

  assert.equal(Buffer.from(signed.body).includes(SECRET), false);
  for (const value of Object.values(signed.headers)) {
    assert.equal(value.includes(SECRET), false);
  }
});
