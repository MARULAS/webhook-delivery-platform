/**
 * The outbound webhook HTTP client (ARCHITECTURE.md section 13).
 *
 * Deliberately thin: one POST, one hard timeout, one measured duration, and a
 * result value describing what happened. It makes no retry decision and has no
 * hidden retry behavior — retrying is a delivery-lifecycle decision that must
 * stay visible and persisted (ENGINEERING_RULES.md section 12), not something
 * an HTTP layer does silently.
 *
 * Node's built-in `fetch` covers everything needed here (timeout via
 * AbortSignal, redirect control, status inspection), so no HTTP dependency is
 * added.
 *
 * Redirects are never followed: `redirect: "manual"` returns the 3xx response
 * as-is. Following one would send a signed payload to a destination that never
 * passed URL safety validation, which is an SSRF bypass. The caller classifies
 * the 3xx as a failure.
 *
 * Receiver response bodies are discarded without being read. Nothing in the
 * platform needs them, and not reading them means a hostile or broken receiver
 * cannot stream an unbounded body at the worker, and no receiver content can
 * ever reach a log line or a stored attempt record.
 */

export type OutboundOutcome =
  /** A response arrived. `statusCode` may be any status, including 4xx/5xx. */
  | { readonly kind: "response"; readonly statusCode: number; readonly durationMs: number }
  /** The request exceeded the configured timeout and was aborted. */
  | { readonly kind: "timeout"; readonly durationMs: number }
  /** The request never produced a response: DNS, TCP, or TLS failure. */
  | { readonly kind: "connection-error"; readonly durationMs: number; readonly code: string };

export interface OutboundRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly timeoutMs: number;
}

/**
 * Extracts a short, stable identifier for a connection failure — normally an
 * errno such as `ECONNREFUSED`. Only the code is used, never the full message,
 * so nothing unexpected from the network stack ends up persisted.
 */
function connectionErrorCode(err: unknown): string {
  if (err instanceof Error && err.cause !== null && typeof err.cause === "object") {
    const { code } = err.cause as { code?: unknown };
    if (typeof code === "string" && code.length > 0) {
      return code;
    }
  }
  return "CONNECTION_FAILED";
}

export async function sendWebhookRequest(request: OutboundRequest): Promise<OutboundOutcome> {
  const startedAt = performance.now();

  try {
    const response = await fetch(request.url, {
      method: "POST",
      headers: { ...request.headers },
      body: request.body,
      redirect: "manual",
      signal: AbortSignal.timeout(request.timeoutMs),
    });

    const durationMs = Math.round(performance.now() - startedAt);

    // Release the socket without consuming the body. Failing to cancel must
    // not turn a delivered webhook into a reported failure, so this cannot
    // throw into the result below.
    await response.body?.cancel().catch(() => undefined);

    return { kind: "response", statusCode: response.status, durationMs };
  } catch (err) {
    const durationMs = Math.round(performance.now() - startedAt);

    // AbortSignal.timeout rejects with a TimeoutError DOMException. Everything
    // else that prevents a response is a connection-level failure.
    if (err instanceof Error && err.name === "TimeoutError") {
      return { kind: "timeout", durationMs };
    }

    return { kind: "connection-error", durationMs, code: connectionErrorCode(err) };
  }
}
