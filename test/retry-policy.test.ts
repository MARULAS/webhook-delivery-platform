import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateNextAttemptAt, isRetryBudgetExhausted } from "../src/worker/retry-policy.ts";

/**
 * The retry policy is pure, so it is tested purely. These cover the two things
 * the plan flags as high-risk: the shape of the backoff (increasing, bounded,
 * configuration-driven) and the off-by-one in the attempt budget.
 */

const now = new Date("2026-08-13T10:00:00.000Z");
const config = { retryBaseDelayMs: 1000, retryMaxDelayMs: 60_000 };

function delayAfter(attemptsMade: number, policy = config): number {
  return calculateNextAttemptAt(attemptsMade, now, policy).getTime() - now.getTime();
}

test("the delay doubles from the base delay with each attempt made", () => {
  assert.equal(delayAfter(1), 1000);
  assert.equal(delayAfter(2), 2000);
  assert.equal(delayAfter(3), 4000);
  assert.equal(delayAfter(4), 8000);
});

test("the delay is bounded by the configured maximum and never exceeds it", () => {
  // 1000 * 2^6 = 64000, past the 60000 ceiling.
  assert.equal(delayAfter(7), 60_000);
  assert.equal(delayAfter(20), 60_000);
  // Far past the point where 2^n overflows to Infinity, which must clamp to
  // the maximum rather than produce an Invalid Date.
  const far = calculateNextAttemptAt(5000, now, config);
  assert.equal(Number.isNaN(far.getTime()), false);
  assert.equal(far.getTime() - now.getTime(), 60_000);
});

test("the delays come from configuration, not from literals in the policy", () => {
  const slower = { retryBaseDelayMs: 250, retryMaxDelayMs: 900 };
  assert.equal(delayAfter(1, slower), 250);
  assert.equal(delayAfter(2, slower), 500);
  assert.equal(delayAfter(3, slower), 900, "saturates at this configuration's own maximum");
});

test("the budget exhausts on the last permitted attempt, not one either side of it", () => {
  // A budget of 5 permits attempts 1..5. After the fourth there is still one
  // left; after the fifth there is not.
  assert.equal(isRetryBudgetExhausted(4, 5), false);
  assert.equal(isRetryBudgetExhausted(5, 5), true);
  assert.equal(isRetryBudgetExhausted(6, 5), true);
  // A budget of 1 means the first attempt is also the last.
  assert.equal(isRetryBudgetExhausted(0, 1), false);
  assert.equal(isRetryBudgetExhausted(1, 1), true);
});
