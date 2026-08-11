import type { FastifyBaseLogger } from "fastify";
import type { AppConfig } from "../../app/config.ts";

/**
 * Fastify logger options, derived from centralized config.
 *
 * Redaction is seeded with `authorization` so request/response logging never
 * leaks bearer credentials. Later parts must extend this list rather than
 * bypass it whenever a new header or field could carry a secret.
 */
export function buildLoggerOptions(config: AppConfig) {
  return {
    level: config.logLevel,
    redact: {
      paths: ["req.headers.authorization", "*.authorization"],
      censor: "[REDACTED]",
    },
  };
}

export type Logger = FastifyBaseLogger;
