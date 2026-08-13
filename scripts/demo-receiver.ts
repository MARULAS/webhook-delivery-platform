import http from "node:http";
import type { AddressInfo } from "node:net";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER } from "../src/infrastructure/security/signing.ts";
import {
  DEFAULT_TOLERANCE_SECONDS,
  verifyWebhookSignature,
  type VerifyWebhookSignatureResult,
} from "./verify-signature.ts";

/**
 * A lightweight local webhook receiver for manual demonstration
 * (SPEC.md section 27, ARCHITECTURE.md section 29).
 *
 * This is a standalone `node:http` script, run directly with `node` — it
 * does not import Fastify or anything under `src/app/`, and it is never
 * registered by `src/app/server.ts`. It is demo scaffolding, not a product
 * feature, and it deliberately stays small: a handful of CLI flags select
 * one canned response behavior, nothing more. `test/helpers/test-receiver.ts`
 * is the separate, smaller receiver the integration test suite uses; this
 * script exists only for the manual demo walkthrough in README.md.
 *
 * Usage:
 *   node scripts/demo-receiver.ts --secret=<endpoint signing secret> [options]
 *
 * Options:
 *   --port=<n>                 Port to listen on (default 4000)
 *   --mode=success|fail|timeout
 *                               success (default): respond 2xx, unless
 *                                 --fail-times says otherwise.
 *                               fail: respond 500 to every request.
 *                               timeout: never respond in time — delays past
 *                                 the configured delivery timeout so the
 *                                 platform observes a timeout.
 *   --fail-times=<n>           Only with --mode=success (the default): fail
 *                               the first n requests with 500, then succeed.
 *                               Demonstrates a retryable failure followed by
 *                               an automatic retry that succeeds.
 *   --secret=<value>           Required. The target endpoint's signing
 *                               secret, used only to verify inbound
 *                               signatures. Never read from the database —
 *                               the platform API never re-exposes it after
 *                               endpoint creation, so it must be supplied
 *                               here explicitly (or via WEBHOOK_SECRET).
 *   --delivery-timeout-ms=<n>  Mirrors the platform's DELIVERY_TIMEOUT_MS
 *                               (src/app/config.ts); only used to size the
 *                               delay in --mode=timeout. Defaults to 10000,
 *                               the same default config.ts uses.
 *   --tolerance-seconds=<n>    Signature timestamp tolerance window.
 *
 * A connection-refused scenario needs no flag: point an endpoint at a port
 * nothing is listening on.
 */

type ReceiverMode = "success" | "fail" | "timeout";

interface CliOptions {
  readonly port: number;
  readonly mode: ReceiverMode;
  readonly failTimes: number;
  readonly secret: string;
  readonly deliveryTimeoutMs: number;
  readonly toleranceSeconds: number;
}

function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv): CliOptions {
  const raw = new Map<string, string>();
  for (const arg of argv) {
    const match = /^--([a-zA-Z-]+)=(.*)$/.exec(arg);
    if (match) {
      raw.set(match[1]!, match[2]!);
    }
  }

  const port = Number(raw.get("port") ?? env.DEMO_RECEIVER_PORT ?? "4000");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`--port must be an integer between 1 and 65535, got "${raw.get("port")}".`);
  }

  const modeRaw = raw.get("mode") ?? "success";
  if (modeRaw !== "success" && modeRaw !== "fail" && modeRaw !== "timeout") {
    throw new Error(`--mode must be one of success, fail, timeout, got "${modeRaw}".`);
  }

  const failTimesRaw = raw.get("fail-times") ?? "0";
  const failTimes = Number(failTimesRaw);
  if (!Number.isInteger(failTimes) || failTimes < 0) {
    throw new Error(`--fail-times must be a non-negative integer, got "${failTimesRaw}".`);
  }

  // The signing secret is never read from the database — the API does not
  // re-expose it after endpoint creation (SPEC.md section 6) — so it must be
  // supplied explicitly here, the same way any real external receiver would
  // have been given it out of band when the endpoint was registered.
  const secret = raw.get("secret") ?? env.WEBHOOK_SECRET;
  if (secret === undefined || secret === "") {
    throw new Error("A signing secret is required: pass --secret=<value> or set WEBHOOK_SECRET.");
  }

  // Mirrors the application's own DELIVERY_TIMEOUT_MS variable
  // (src/app/config.ts) rather than a magic number disconnected from it, so
  // --mode=timeout stays meaningful against however the app is actually
  // configured. This script does not import src/app/config.ts itself: that
  // module is part of the application, not demo scaffolding, and importing
  // it would also pull in its process-wide validate-at-import-time behavior.
  const deliveryTimeoutRaw = raw.get("delivery-timeout-ms") ?? env.DELIVERY_TIMEOUT_MS ?? "10000";
  const deliveryTimeoutMs = Number(deliveryTimeoutRaw);
  if (!Number.isInteger(deliveryTimeoutMs) || deliveryTimeoutMs <= 0) {
    throw new Error(`--delivery-timeout-ms must be a positive integer, got "${deliveryTimeoutRaw}".`);
  }

  const toleranceRaw = raw.get("tolerance-seconds") ?? String(DEFAULT_TOLERANCE_SECONDS);
  const toleranceSeconds = Number(toleranceRaw);
  if (!Number.isInteger(toleranceSeconds) || toleranceSeconds <= 0) {
    throw new Error(`--tolerance-seconds must be a positive integer, got "${toleranceRaw}".`);
  }

  return { port, mode: modeRaw, failTimes, secret, deliveryTimeoutMs, toleranceSeconds };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Logs one line per request to stdout: request number, method, path, the
 * envelope fields useful for following the demo (never the payload body, to
 * stay consistent with ENGINEERING_RULES.md section 18), and the signature
 * verification outcome. Never logs the secret or the raw signature value.
 */
function logRequest(
  requestNumber: number,
  req: http.IncomingMessage,
  rawBody: Buffer,
  verification: VerifyWebhookSignatureResult,
): void {
  let envelope: { deliveryId?: unknown; eventId?: unknown; type?: unknown } = {};
  try {
    envelope = JSON.parse(rawBody.toString("utf8")) as typeof envelope;
  } catch {
    // Not JSON (or an empty body); nothing further to report about it.
  }

  const summary = {
    requestNumber,
    method: req.method,
    path: req.url,
    deliveryId: envelope.deliveryId,
    eventId: envelope.eventId,
    type: envelope.type,
    signature: verification.valid ? "valid" : `invalid (${verification.reason})`,
  };
  process.stdout.write(`[demo-receiver] ${JSON.stringify(summary)}\n`);
}

function startDemoReceiver(options: CliOptions): http.Server {
  let requestCount = 0;

  return http.createServer((req, res) => {
    req.on("error", () => undefined);
    res.on("error", () => undefined);

    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requestCount += 1;
      const rawBody = Buffer.concat(chunks);

      const verification = verifyWebhookSignature({
        rawBody,
        signatureHeader: headerValue(req.headers[SIGNATURE_HEADER]),
        timestampHeader: headerValue(req.headers[TIMESTAMP_HEADER]),
        secret: options.secret,
        toleranceSeconds: options.toleranceSeconds,
      });
      logRequest(requestCount, req, rawBody, verification);

      if (options.mode === "timeout") {
        // Comfortably past the platform's configured delivery timeout, so
        // the worker aborts and records a TIMEOUT attempt before this ever
        // writes a response.
        const delayMs = options.deliveryTimeoutMs + 2000;
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
        }, delayMs).unref();
        return;
      }

      if (options.mode === "fail") {
        res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ ok: false }));
        return;
      }

      // mode === "success": fail the first `failTimes` requests, then
      // succeed — demonstrates a retryable failure followed by a successful
      // automatic retry.
      if (requestCount <= options.failTimes) {
        res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ ok: false }));
        return;
      }

      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    });
  });
}

function main(): void {
  const options = parseArgs(process.argv.slice(2), process.env);
  const server = startDemoReceiver(options);

  server.listen(options.port, "127.0.0.1", () => {
    const address = server.address() as AddressInfo;
    const failNote = options.mode === "success" && options.failTimes > 0 ? `, fail-times=${options.failTimes}` : "";
    process.stdout.write(
      `[demo-receiver] listening on http://127.0.0.1:${address.port} (mode=${options.mode}${failNote})\n`,
    );
  });

  const shutdown = (): void => {
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

try {
  main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`demo-receiver failed to start: ${message}\n`);
  process.exit(1);
}
