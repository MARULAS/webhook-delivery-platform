import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, ConfigError } from "../src/app/config.ts";

const validEnv = {
  DATABASE_URL: "postgresql://webhooks:webhooks@localhost:5432/webhooks",
  PORT: "4000",
  LOG_LEVEL: "debug",
  NODE_ENV: "test",
};

test("loadConfig rejects a missing DATABASE_URL", () => {
  const { DATABASE_URL: _omit, ...rest } = validEnv;
  assert.throws(() => loadConfig(rest), ConfigError);
});

test("loadConfig rejects a non-numeric PORT", () => {
  assert.throws(() => loadConfig({ ...validEnv, PORT: "not-a-number" }), ConfigError);
});

test("loadConfig rejects an out-of-enum NODE_ENV", () => {
  assert.throws(() => loadConfig({ ...validEnv, NODE_ENV: "staging" }), ConfigError);
});

test("loadConfig accepts a fully valid environment and preserves its values", () => {
  const config = loadConfig(validEnv);
  assert.equal(config.databaseUrl, validEnv.DATABASE_URL);
  assert.equal(config.port, 4000);
  assert.equal(config.logLevel, "debug");
  assert.equal(config.nodeEnv, "test");
});

test("loadConfig applies documented defaults when optional variables are absent", () => {
  const config = loadConfig({ DATABASE_URL: validEnv.DATABASE_URL });
  assert.equal(config.port, 3000);
  assert.equal(config.logLevel, "info");
  assert.equal(config.nodeEnv, "development");
  assert.equal(config.allowLocalEndpoints, false);
});

test("loadConfig accepts ALLOW_LOCAL_ENDPOINTS=true outside production", () => {
  const config = loadConfig({ ...validEnv, NODE_ENV: "development", ALLOW_LOCAL_ENDPOINTS: "true" });
  assert.equal(config.allowLocalEndpoints, true);
});

test("loadConfig fails closed: ALLOW_LOCAL_ENDPOINTS=true is rejected under NODE_ENV=production", () => {
  assert.throws(
    () => loadConfig({ ...validEnv, NODE_ENV: "production", ALLOW_LOCAL_ENDPOINTS: "true" }),
    ConfigError,
  );
});

test("loadConfig accepts ALLOW_LOCAL_ENDPOINTS=false under NODE_ENV=production", () => {
  const config = loadConfig({ ...validEnv, NODE_ENV: "production", ALLOW_LOCAL_ENDPOINTS: "false" });
  assert.equal(config.allowLocalEndpoints, false);
});
