import { createHash } from "node:crypto";

/**
 * Fingerprints a publishing request so D2 (IMPLEMENTATION_PLAN.md section 3)
 * can tell a genuine replay of the same request from a reuse of the same
 * `Idempotency-Key` for a materially different one.
 *
 * The hash is taken over a canonical serialization of `{ type, payload }`:
 * object keys sorted, array order preserved. Without the sort, two requests
 * that differ only in JSON key order would look "materially different" and be
 * rejected with a 409, which would make a plain client retry fail.
 *
 * Hashing rather than deep-comparing the stored payload also avoids depending
 * on how PostgreSQL's jsonb normalizes the value on the way back out: jsonb
 * does not preserve key order or the original number formatting, so a
 * round-tripped payload is not guaranteed to compare equal to the request that
 * produced it.
 */
export function hashPublishRequest(type: string, payload: unknown): string {
  return createHash("sha256").update(canonicalize({ type, payload })).digest("hex");
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    // JSON.stringify returns undefined for undefined; a parsed JSON body
    // cannot contain it, but fall back rather than emit "undefined".
    return JSON.stringify(value) ?? "null";
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    // Explicit code-unit comparison rather than the default locale-sensitive
    // sort, so the same request always hashes the same way anywhere.
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalize(entryValue)}`).join(",")}}`;
}
