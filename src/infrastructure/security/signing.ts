import { createHmac } from "node:crypto";

/**
 * Centralized outbound webhook signing (SPEC.md section 13, ARCHITECTURE.md
 * sections 19-20).
 *
 * This is the only place in the codebase that computes a webhook signature.
 * Worker code must not build one itself.
 *
 * ## The serialize-once rule
 *
 * The classic failure this module exists to prevent is serializing the payload
 * once for signing and again for sending: two `JSON.stringify` calls that
 * differ in key order or number formatting produce a signature the receiver
 * cannot verify, intermittently and unreproducibly.
 *
 * `buildSignedWebhookRequest` is therefore the only exported entry point and it
 * returns the body it signed. There is no way for a caller to obtain a body
 * without its matching signature, or a signature without its body: the payload
 * is serialized exactly once, into a byte array that is both the HMAC input and
 * the request body passed to the HTTP client verbatim.
 *
 * ## Wire format
 *
 * Two headers accompany every outbound request:
 *
 *   X-Webhook-Timestamp: <unix time in whole seconds>
 *   X-Webhook-Signature: sha256=<lowercase hex HMAC-SHA256>
 *
 * The signed string is the timestamp, a literal `.`, and the raw request body:
 *
 *   HMAC-SHA256(key = endpoint signing secret, message = "<timestamp>." || <body bytes>)
 *
 * The separator makes the boundary between the two inputs explicit, so no two
 * different (timestamp, body) pairs can produce the same signed message. The
 * timestamp is inside the signed message, not merely alongside it, so it cannot
 * be altered by a man-in-the-middle replaying an old body with a fresh
 * timestamp. Receivers should reject requests whose timestamp is outside an
 * acceptable tolerance window (SPEC.md section 14) and compare signatures with
 * a constant-time function.
 *
 * The `sha256=` prefix names the algorithm on the wire, so a future algorithm
 * change is a version a receiver can detect rather than a silent difference.
 *
 * The endpoint secret is used only as the HMAC key. It is never placed in the
 * payload, in a header, in a log line, or in a DeliveryAttempt row.
 */

export const SIGNATURE_HEADER = "x-webhook-signature";
export const TIMESTAMP_HEADER = "x-webhook-timestamp";
export const SIGNATURE_ALGORITHM_PREFIX = "sha256=";

const USER_AGENT = "WebhookDeliveryPlatform/1.0";

export interface SignedWebhookRequest {
  /** The exact bytes that were signed and that must be sent as the body. */
  readonly body: Uint8Array;
  readonly headers: Readonly<Record<string, string>>;
  readonly timestampSeconds: number;
}

/**
 * Serializes `payload` once, signs those exact bytes together with the
 * delivery timestamp, and returns both the bytes and the headers to send.
 */
export function buildSignedWebhookRequest(
  payload: unknown,
  signingSecret: string,
  sentAt: Date,
): SignedWebhookRequest {
  const timestampSeconds = Math.floor(sentAt.getTime() / 1000);

  // The single serialization. Everything below operates on `body`.
  const body = Buffer.from(JSON.stringify(payload), "utf8");

  const hmac = createHmac("sha256", signingSecret);
  hmac.update(`${timestampSeconds}.`, "utf8");
  hmac.update(body);
  const signature = `${SIGNATURE_ALGORITHM_PREFIX}${hmac.digest("hex")}`;

  return {
    body,
    headers: {
      "content-type": "application/json",
      "user-agent": USER_AGENT,
      [TIMESTAMP_HEADER]: String(timestampSeconds),
      [SIGNATURE_HEADER]: signature,
    },
    timestampSeconds,
  };
}
