import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSignedWebhookRequest, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "../src/infrastructure/security/signing.ts";
import { verifyWebhookSignature } from "../scripts/verify-signature.ts";

/**
 * Part 7: the receiver-side verification example must verify a real
 * signature produced by the platform's own signing code, not a
 * re-implementation of it (IMPLEMENTATION_PLAN.md Part 7 testing
 * requirement). This is the one place the two independent implementations —
 * outbound signing and inbound verification — are checked against each
 * other.
 */

const SECRET = "9f2b6c7e1a4d8035bf6c19e2a7d4f803";

test("a signature produced by buildSignedWebhookRequest verifies successfully", () => {
  const sentAt = new Date("2026-08-13T09:00:00.000Z");
  const signed = buildSignedWebhookRequest({ type: "order.completed", payload: { orderId: 1 } }, SECRET, sentAt);

  const result = verifyWebhookSignature({
    rawBody: signed.body,
    signatureHeader: signed.headers[SIGNATURE_HEADER],
    timestampHeader: signed.headers[TIMESTAMP_HEADER],
    secret: SECRET,
    now: sentAt,
  });

  assert.deepEqual(result, { valid: true });
});

test("a tampered body fails verification", () => {
  const sentAt = new Date("2026-08-13T09:00:00.000Z");
  const signed = buildSignedWebhookRequest({ type: "order.completed", payload: { orderId: 1 } }, SECRET, sentAt);

  const tamperedBody = Buffer.from(
    JSON.stringify({ type: "order.completed", payload: { orderId: 999 } }),
    "utf8",
  );

  const result = verifyWebhookSignature({
    rawBody: tamperedBody,
    signatureHeader: signed.headers[SIGNATURE_HEADER],
    timestampHeader: signed.headers[TIMESTAMP_HEADER],
    secret: SECRET,
    now: sentAt,
  });

  assert.equal(result.valid, false);
});

test("a tampered signature fails verification", () => {
  const sentAt = new Date("2026-08-13T09:00:00.000Z");
  const signed = buildSignedWebhookRequest({ type: "order.completed", payload: { orderId: 1 } }, SECRET, sentAt);

  const forgedSignature = signed.headers[SIGNATURE_HEADER].slice(0, -1) + (signed.headers[SIGNATURE_HEADER].endsWith("0") ? "1" : "0");

  const result = verifyWebhookSignature({
    rawBody: signed.body,
    signatureHeader: forgedSignature,
    timestampHeader: signed.headers[TIMESTAMP_HEADER],
    secret: SECRET,
    now: sentAt,
  });

  assert.deepEqual(result, { valid: false, reason: "signature mismatch" });
});

test("the wrong secret fails verification", () => {
  const sentAt = new Date("2026-08-13T09:00:00.000Z");
  const signed = buildSignedWebhookRequest({ type: "order.completed", payload: { orderId: 1 } }, SECRET, sentAt);

  const result = verifyWebhookSignature({
    rawBody: signed.body,
    signatureHeader: signed.headers[SIGNATURE_HEADER],
    timestampHeader: signed.headers[TIMESTAMP_HEADER],
    secret: "a completely different secret",
    now: sentAt,
  });

  assert.deepEqual(result, { valid: false, reason: "signature mismatch" });
});

test("a stale timestamp outside the tolerance window fails verification even with a correct signature", () => {
  const sentAt = new Date("2026-08-13T09:00:00.000Z");
  const signed = buildSignedWebhookRequest({ type: "order.completed", payload: { orderId: 1 } }, SECRET, sentAt);

  // Verifying 10 minutes later, with the default 5-minute tolerance.
  const tenMinutesLater = new Date(sentAt.getTime() + 10 * 60_000);

  const result = verifyWebhookSignature({
    rawBody: signed.body,
    signatureHeader: signed.headers[SIGNATURE_HEADER],
    timestampHeader: signed.headers[TIMESTAMP_HEADER],
    secret: SECRET,
    now: tenMinutesLater,
  });

  assert.equal(result.valid, false);
  assert.ok(!result.valid && result.reason.includes("tolerance window"));
});

test("a stale timestamp still verifies within an explicitly widened tolerance window", () => {
  const sentAt = new Date("2026-08-13T09:00:00.000Z");
  const signed = buildSignedWebhookRequest({ type: "order.completed", payload: { orderId: 1 } }, SECRET, sentAt);
  const tenMinutesLater = new Date(sentAt.getTime() + 10 * 60_000);

  const result = verifyWebhookSignature({
    rawBody: signed.body,
    signatureHeader: signed.headers[SIGNATURE_HEADER],
    timestampHeader: signed.headers[TIMESTAMP_HEADER],
    secret: SECRET,
    now: tenMinutesLater,
    toleranceSeconds: 3600,
  });

  assert.deepEqual(result, { valid: true });
});

test("a missing signature or timestamp header fails verification", () => {
  const sentAt = new Date();
  const signed = buildSignedWebhookRequest({ payload: {} }, SECRET, sentAt);

  const missingSignature = verifyWebhookSignature({
    rawBody: signed.body,
    signatureHeader: undefined,
    timestampHeader: signed.headers[TIMESTAMP_HEADER],
    secret: SECRET,
  });
  assert.equal(missingSignature.valid, false);

  const missingTimestamp = verifyWebhookSignature({
    rawBody: signed.body,
    signatureHeader: signed.headers[SIGNATURE_HEADER],
    timestampHeader: undefined,
    secret: SECRET,
  });
  assert.equal(missingTimestamp.valid, false);
});
