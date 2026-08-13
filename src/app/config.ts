/**
 * Centralized configuration.
 *
 * This is the only module in the application allowed to read `process.env`.
 * Every other module receives configuration through the exported `config`
 * object. Validation happens once, at import time: missing or malformed
 * required values throw immediately so the process fails fast instead of
 * booting with a silently wrong default.
 */

const VALID_NODE_ENVS = ["development", "test", "production"] as const;

export type NodeEnv = (typeof VALID_NODE_ENVS)[number];

export interface AppConfig {
  readonly databaseUrl: string;
  readonly port: number;
  readonly logLevel: string;
  readonly nodeEnv: NodeEnv;
  readonly allowLocalEndpoints: boolean;
  readonly workerEnabled: boolean;
  readonly workerPollIntervalMs: number;
  readonly workerConcurrency: number;
  readonly workerBatchSize: number;
  readonly deliveryTimeoutMs: number;
  /** Derived, not read from the environment. See `deriveDeliveryLeaseMs`. */
  readonly deliveryLeaseMs: number;
  readonly maxDeliveryAttempts: number;
  readonly retryBaseDelayMs: number;
  readonly retryMaxDelayMs: number;
  readonly workerShutdownGraceMs: number;
  /** Derived from `LEASE_OVERHEAD_PER_DELIVERY_MS`; see the comment there. */
  readonly databaseConnectionTimeoutMs: number;
  /** Derived from `LEASE_OVERHEAD_PER_DELIVERY_MS`; see the comment there. */
  readonly deliveryTransactionTimeoutMs: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const VALID_LOG_LEVELS = new Set([
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
]);

function isNodeEnv(value: string): value is NodeEnv {
  return (VALID_NODE_ENVS as readonly string[]).includes(value);
}

interface IntegerRange {
  readonly min: number;
  readonly max: number;
  readonly fallback: number;
}

/**
 * Parses an optional integer variable, recording a problem rather than
 * throwing so the caller can report every invalid variable at once. An
 * out-of-range or non-integer value is never silently clamped.
 */
function parseIntegerEnv(
  raw: string | undefined,
  name: string,
  range: IntegerRange,
  problems: string[],
): number {
  if (raw === undefined || raw === "") {
    return range.fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < range.min || parsed > range.max) {
    problems.push(`${name} must be an integer between ${range.min} and ${range.max}, got "${raw}".`);
    return range.fallback;
  }
  return parsed;
}

/**
 * Per-delivery allowance for work that is not the outbound request itself:
 * loading the delivery with its endpoint and event, then the transaction that
 * writes the attempt and the state change — roughly three or four round trips
 * to PostgreSQL.
 *
 * This is deliberately far larger than those round trips cost in practice. The
 * two directions are not symmetric: a lease that is too long only delays
 * recovery of a genuinely dead worker, while a lease that is too short lets a
 * live delivery be reclaimed and the same webhook sent twice. Erring long is
 * therefore the safe error.
 *
 * Since the retry lifecycle exists, this allowance is load-bearing rather than
 * merely generous: it is what keeps a live delivery from outrunning its lease.
 * So it is enforced rather than assumed. The two timeouts below are derived
 * from it and bound the database work a single delivery can perform — an
 * exhausted connection pool or a transaction blocked on a lock now fails fast
 * instead of waiting indefinitely while the lease expires underneath it.
 * Their worst case (a connection wait, then a transaction that waits for its
 * own connection and then runs) stays inside the allowance.
 */
const LEASE_OVERHEAD_PER_DELIVERY_MS = 1000;

/** How long a query may wait for a free connection from the pg pool. */
const DATABASE_CONNECTION_TIMEOUT_MS = LEASE_OVERHEAD_PER_DELIVERY_MS / 4;

/** Maximum duration of the interactive transaction that records an attempt. */
const DELIVERY_TRANSACTION_TIMEOUT_MS = LEASE_OVERHEAD_PER_DELIVERY_MS / 2;

/**
 * The processing lease is derived from the delivery timeout rather than
 * configured independently, so no environment value can set a lease shorter
 * than the request it has to cover — reclaiming work a worker is still
 * performing would send the same webhook twice, which is the highest-severity
 * failure this system can produce.
 *
 * The derivation rests on one assumption it cannot derive: that a delivery's
 * database work fits inside `LEASE_OVERHEAD_PER_DELIVERY_MS`. That assumption
 * is enforced by the two timeouts declared with that constant, not merely
 * hoped for. If it were ever violated anyway, the fencing token on the state
 * transitions still protects the delivery's *state* — but not the receiver,
 * which would see the request twice.
 *
 * A worker claims `workerBatchSize` deliveries at once and runs them through a
 * pool of `workerConcurrency`, so each pool slot processes up to
 * `k = ceil(batchSize / concurrency)` deliveries in sequence. `leaseUntil` is
 * stamped once, at claim time, for every row in the batch — so the last
 * delivery in a slot's queue has already burned the time taken by the `k - 1`
 * before it prior to its own request starting.
 *
 * The lease therefore has to cover `k` deliveries end to end, and the cost of
 * each one is a full timeout *plus* its own database work. That overhead is
 * per-delivery, so the allowance for it has to be multiplied by `k` too: a
 * single flat addition for the whole batch would be exceeded as soon as
 * per-delivery overhead grew past `timeoutMs / k`, which is reachable inside
 * the validated configuration ranges (a 100 ms timeout with a batch of 1000 at
 * concurrency 1 leaves 0.1 ms per delivery). Hence `k` scaled units of
 * (timeout + overhead), plus one final timeout of slack.
 *
 * The result is always strictly greater than the timeout. At the maximum
 * validated inputs (timeout 300000, batch 1000, concurrency 1, so k = 1000)
 * it is 301,300,000 ms, which stays well inside the int4 range the claim query
 * binds it as.
 */
function deriveDeliveryLeaseMs(timeoutMs: number, batchSize: number, concurrency: number): number {
  const perSlotQueueLength = Math.ceil(batchSize / concurrency);
  return perSlotQueueLength * (timeoutMs + LEASE_OVERHEAD_PER_DELIVERY_MS) + timeoutMs;
}

/**
 * Parses and validates configuration from the given environment source.
 * Collects every problem before throwing, so a caller sees all invalid
 * variables in one message instead of fixing them one at a time.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const problems: string[] = [];

  let databaseUrl = "";
  const rawDatabaseUrl = env.DATABASE_URL;
  if (!rawDatabaseUrl || rawDatabaseUrl.trim() === "") {
    problems.push("DATABASE_URL is required and must be a non-empty connection string.");
  } else {
    databaseUrl = rawDatabaseUrl;
  }

  let port = 3000;
  if (env.PORT !== undefined && env.PORT !== "") {
    const parsedPort = Number(env.PORT);
    if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
      problems.push(`PORT must be an integer between 1 and 65535, got "${env.PORT}".`);
    } else {
      port = parsedPort;
    }
  }

  let logLevel = "info";
  if (env.LOG_LEVEL !== undefined && env.LOG_LEVEL !== "") {
    if (!VALID_LOG_LEVELS.has(env.LOG_LEVEL)) {
      problems.push(
        `LOG_LEVEL must be one of ${[...VALID_LOG_LEVELS].join(", ")}, got "${env.LOG_LEVEL}".`,
      );
    } else {
      logLevel = env.LOG_LEVEL;
    }
  }

  let nodeEnv: NodeEnv = "development";
  if (env.NODE_ENV !== undefined && env.NODE_ENV !== "") {
    if (!isNodeEnv(env.NODE_ENV)) {
      problems.push(
        `NODE_ENV must be one of ${VALID_NODE_ENVS.join(", ")}, got "${env.NODE_ENV}".`,
      );
    } else {
      nodeEnv = env.NODE_ENV;
    }
  }

  // D5 (IMPLEMENTATION_PLAN.md section 3): a single, explicit, development-only
  // flag that lets the URL safety module (src/infrastructure/security/url-safety.ts)
  // accept loopback destinations for the local test receiver. Fail closed: a
  // true value is rejected outright at config load when NODE_ENV=production,
  // rather than silently downgraded to false, so a production misconfiguration
  // is a startup failure, not a silent security gap. The URL safety module also
  // never consults this flag when nodeEnv is "production", as a second,
  // independent guard.
  let allowLocalEndpoints = false;
  const rawAllowLocalEndpoints = env.ALLOW_LOCAL_ENDPOINTS;
  if (rawAllowLocalEndpoints !== undefined && rawAllowLocalEndpoints !== "") {
    if (rawAllowLocalEndpoints !== "true" && rawAllowLocalEndpoints !== "false") {
      problems.push(
        `ALLOW_LOCAL_ENDPOINTS must be "true" or "false", got "${rawAllowLocalEndpoints}".`,
      );
    } else {
      allowLocalEndpoints = rawAllowLocalEndpoints === "true";
    }
  }

  if (allowLocalEndpoints && nodeEnv === "production") {
    problems.push("ALLOW_LOCAL_ENDPOINTS must not be true when NODE_ENV=production.");
  }

  // The worker runs in the same process as the API (ARCHITECTURE.md section 2),
  // so it is on by default: a deployment that forgot this variable should still
  // deliver webhooks rather than silently accumulate PENDING rows. Turning it
  // off is the explicit choice, and it is what tests use so they can drive the
  // worker one iteration at a time instead of racing a background loop.
  let workerEnabled = true;
  const rawWorkerEnabled = env.WORKER_ENABLED;
  if (rawWorkerEnabled !== undefined && rawWorkerEnabled !== "") {
    if (rawWorkerEnabled !== "true" && rawWorkerEnabled !== "false") {
      problems.push(`WORKER_ENABLED must be "true" or "false", got "${rawWorkerEnabled}".`);
    } else {
      workerEnabled = rawWorkerEnabled === "true";
    }
  }

  const workerPollIntervalMs = parseIntegerEnv(
    env.WORKER_POLL_INTERVAL_MS,
    "WORKER_POLL_INTERVAL_MS",
    { min: 10, max: 3_600_000, fallback: 1000 },
    problems,
  );

  const workerConcurrency = parseIntegerEnv(
    env.WORKER_CONCURRENCY,
    "WORKER_CONCURRENCY",
    { min: 1, max: 256, fallback: 5 },
    problems,
  );

  const workerBatchSize = parseIntegerEnv(
    env.WORKER_BATCH_SIZE,
    "WORKER_BATCH_SIZE",
    { min: 1, max: 1000, fallback: 20 },
    problems,
  );

  const deliveryTimeoutMs = parseIntegerEnv(
    env.DELIVERY_TIMEOUT_MS,
    "DELIVERY_TIMEOUT_MS",
    { min: 100, max: 300_000, fallback: 10_000 },
    problems,
  );

  // The retry policy's only home (ARCHITECTURE.md section 15). No timing
  // literal for backoff or for the attempt budget may appear in business code;
  // src/worker/retry-policy.ts computes purely from these values.

  // SPEC.md section 10 sketches a progression of five attempts, so five is the
  // default: one initial delivery plus four automatic retries.
  const maxDeliveryAttempts = parseIntegerEnv(
    env.MAX_DELIVERY_ATTEMPTS,
    "MAX_DELIVERY_ATTEMPTS",
    { min: 1, max: 50, fallback: 5 },
    problems,
  );

  // One second: long enough that a receiver restarting or shedding load has a
  // moment to recover, short enough that the first retry is still prompt. With
  // the defaults the progression is 1s, 2s, 4s, 8s.
  const retryBaseDelayMs = parseIntegerEnv(
    env.RETRY_BASE_DELAY_MS,
    "RETRY_BASE_DELAY_MS",
    { min: 1, max: 3_600_000, fallback: 1000 },
    problems,
  );

  // The ceiling the doubling saturates at, so a long outage does not push a
  // retry days into the future.
  const retryMaxDelayMs = parseIntegerEnv(
    env.RETRY_MAX_DELAY_MS,
    "RETRY_MAX_DELAY_MS",
    { min: 1, max: 86_400_000, fallback: 60_000 },
    problems,
  );

  if (retryMaxDelayMs < retryBaseDelayMs) {
    problems.push(
      `RETRY_MAX_DELAY_MS (${retryMaxDelayMs}) must be greater than or equal to RETRY_BASE_DELAY_MS (${retryBaseDelayMs}).`,
    );
  }

  // How long shutdown waits for the in-flight worker iteration. Bounded on
  // purpose: work that does not finish inside it stays PROCESSING and is
  // recovered when its lease expires, because correctness must never depend on
  // shutdown succeeding (ARCHITECTURE.md section 31). Zero is legal and means
  // "do not wait at all".
  const workerShutdownGraceMs = parseIntegerEnv(
    env.WORKER_SHUTDOWN_GRACE_MS,
    "WORKER_SHUTDOWN_GRACE_MS",
    { min: 0, max: 300_000, fallback: 10_000 },
    problems,
  );

  if (problems.length > 0) {
    throw new ConfigError(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }

  return Object.freeze({
    databaseUrl,
    port,
    logLevel,
    nodeEnv,
    allowLocalEndpoints,
    workerEnabled,
    workerPollIntervalMs,
    workerConcurrency,
    workerBatchSize,
    deliveryTimeoutMs,
    deliveryLeaseMs: deriveDeliveryLeaseMs(deliveryTimeoutMs, workerBatchSize, workerConcurrency),
    maxDeliveryAttempts,
    retryBaseDelayMs,
    retryMaxDelayMs,
    workerShutdownGraceMs,
    databaseConnectionTimeoutMs: DATABASE_CONNECTION_TIMEOUT_MS,
    deliveryTransactionTimeoutMs: DELIVERY_TRANSACTION_TIMEOUT_MS,
  });
}

export const config = loadConfig();
