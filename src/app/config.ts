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

  if (problems.length > 0) {
    throw new ConfigError(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }

  return Object.freeze({
    databaseUrl,
    port,
    logLevel,
    nodeEnv,
    allowLocalEndpoints,
  });
}

export const config = loadConfig();
