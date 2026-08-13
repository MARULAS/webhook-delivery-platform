/**
 * The retry policy (ARCHITECTURE.md section 15, SPEC.md section 10).
 *
 * Deliberately pure: no database, no `Date.now()`, no logging. Everything it
 * needs is passed in, so the schedule a delivery receives can be asserted
 * exactly rather than approximately, and so this module is the single place
 * where retry timing is decided. Business code contains no backoff literal —
 * every value comes from configuration (src/app/config.ts).
 *
 * No jitter. ARCHITECTURE.md section 15 permits it but does not require it,
 * and this platform's retries are spread by the receiver's own failure timing
 * rather than synchronized by a shared trigger, so the thundering-herd problem
 * jitter solves does not really arise here. Omitting it keeps the schedule
 * exactly reproducible in tests and the function trivially reviewable.
 */

export interface RetryPolicyConfig {
  readonly retryBaseDelayMs: number;
  readonly retryMaxDelayMs: number;
}

/**
 * `2 ** 1024` is `Infinity`, which would produce an Invalid Date rather than a
 * clamped one. The exponent is capped well below that: with the largest
 * validated base delay (3_600_000 ms) `2 ** 30` still multiplies to a finite
 * number, and any exponent this large has long since saturated at
 * `retryMaxDelayMs` anyway, so the cap changes no reachable result.
 */
const MAX_BACKOFF_EXPONENT = 30;

/**
 * When a delivery that has made `attemptsMade` attempts becomes eligible again.
 *
 * Bounded exponential backoff:
 *   delay = min(base * 2^(attemptsMade - 1), max)
 *
 * `attemptsMade` counts persisted DeliveryAttempt rows, so the first retry —
 * scheduled after one failed attempt — waits exactly the base delay.
 */
export function calculateNextAttemptAt(
  attemptsMade: number,
  now: Date,
  config: RetryPolicyConfig,
): Date {
  const exponent = Math.min(Math.max(attemptsMade - 1, 0), MAX_BACKOFF_EXPONENT);
  const delayMs = Math.min(config.retryBaseDelayMs * 2 ** exponent, config.retryMaxDelayMs);
  return new Date(now.getTime() + delayMs);
}

/**
 * Whether the automatic-attempt budget is spent, given the number of attempts
 * that have actually been persisted for the delivery.
 *
 * Its own function because the off-by-one here is the failure mode the plan
 * flags as high-risk: `maxDeliveryAttempts` counts attempts *including* the
 * first, so a budget of 5 permits attempts 1 through 5 and exhausts on the
 * fifth — not the fourth, and not the sixth.
 */
export function isRetryBudgetExhausted(attemptsMade: number, maxDeliveryAttempts: number): boolean {
  return attemptsMade >= maxDeliveryAttempts;
}
