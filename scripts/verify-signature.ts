import { createHmac, timingSafeEqual } from "node:crypto";
import {
  SIGNATURE_ALGORITHM_PREFIX,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
} from "../src/infrastructure/security/signing.ts";

/**
 * Receiver-side signature verification (SPEC.md section 14, ARCHITECTURE.md
 * section 29). This is the reference implementation the demo receiver
 * (`scripts/demo-receiver.ts`) uses, factored out so it can be exercised
 * directly by a test without duplicating the crypto logic.
 *
 * It independently recomputes the signature the platform's own signing
 * module (`src/infrastructure/security/signing.ts`) produces — same wire
 * format, same header names — rather than sharing any signing code, since a
 * receiver in the real world would not have access to this codebase either.
 *
 * Two things a naive receiver implementation gets wrong, both handled here:
 *
 *   - comparing signatures with `===` leaks timing information proportional
 *     to how many leading bytes match, so the comparison must be constant
 *     time (`crypto.timingSafeEqual`);
 *   - accepting any timestamp lets an attacker who has captured one valid
 *     signed request replay it indefinitely, so a tolerance window is
 *     enforced.
 */

/** Five minutes: generous enough for ordinary clock skew and network delay
 *  between signing and the receiver's clock, without leaving a replay window
 *  open indefinitely. Callers may override it. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

export interface VerifyWebhookSignatureInput {
  /** The raw, unparsed request body — verification must happen over exactly
   *  the bytes that were signed, before any JSON parsing. */
  readonly rawBody: Buffer | Uint8Array;
  readonly signatureHeader: string | undefined;
  readonly timestampHeader: string | undefined;
  readonly secret: string;
  readonly toleranceSeconds?: number;
  /** Defaults to the current time; overridable so tests can control skew. */
  readonly now?: Date;
}

export type VerifyWebhookSignatureResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: string };

export function verifyWebhookSignature(input: VerifyWebhookSignatureInput): VerifyWebhookSignatureResult {
  const { rawBody, signatureHeader, timestampHeader, secret } = input;
  const toleranceSeconds = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const now = input.now ?? new Date();

  if (timestampHeader === undefined || timestampHeader === "") {
    return { valid: false, reason: `missing ${TIMESTAMP_HEADER} header` };
  }
  if (signatureHeader === undefined || signatureHeader === "") {
    return { valid: false, reason: `missing ${SIGNATURE_HEADER} header` };
  }
  if (!signatureHeader.startsWith(SIGNATURE_ALGORITHM_PREFIX)) {
    return { valid: false, reason: "unsupported signature algorithm" };
  }

  const timestampSeconds = Number(timestampHeader);
  if (!Number.isInteger(timestampSeconds)) {
    return { valid: false, reason: "malformed timestamp" };
  }

  // Reject stale (or, symmetrically, implausibly future) timestamps before
  // touching the signature at all — SPEC.md section 14's replay protection.
  const skewSeconds = Math.abs(Math.floor(now.getTime() / 1000) - timestampSeconds);
  if (skewSeconds > toleranceSeconds) {
    return {
      valid: false,
      reason: `timestamp outside the ${toleranceSeconds}s tolerance window (skew ${skewSeconds}s)`,
    };
  }

  // Recomputed exactly as signing.ts constructs it: HMAC-SHA256 over
  // "<timestamp>." followed by the raw body bytes, keyed by the shared
  // secret.
  const expectedHex = createHmac("sha256", secret)
    .update(`${timestampSeconds}.`, "utf8")
    .update(rawBody)
    .digest("hex");
  const expected = Buffer.from(`${SIGNATURE_ALGORITHM_PREFIX}${expectedHex}`, "utf8");
  const received = Buffer.from(signatureHeader, "utf8");

  // timingSafeEqual throws on mismatched lengths rather than returning false,
  // and a length mismatch is not itself sensitive information (unlike which
  // byte differs), so it is safe to branch on here before the constant-time
  // comparison of equal-length buffers.
  if (expected.length !== received.length) {
    return { valid: false, reason: "signature mismatch" };
  }
  if (!timingSafeEqual(expected, received)) {
    return { valid: false, reason: "signature mismatch" };
  }

  return { valid: true };
}
