import type { AppConfig } from "../app/config.ts";
import type { PrismaClient } from "../infrastructure/database/prisma.ts";
import type { Logger } from "../infrastructure/logging/logger.ts";
import { sendWebhookRequest, type OutboundOutcome } from "../infrastructure/http/outbound-request.ts";
import { buildSignedWebhookRequest } from "../infrastructure/security/signing.ts";
import { assertSafeEndpointUrl } from "../infrastructure/security/url-safety.ts";
import {
  completeDeliveryWithAttempt,
  failDeliveryWithoutAttempt,
  type DeliveryAttemptRecord,
} from "../modules/deliveries/state-transitions.ts";
import { SecurityError } from "../shared/errors/app-error.ts";
import type { ClaimedDelivery } from "./delivery-claiming.ts";

/**
 * Executing one claimed delivery: re-check that it is still safe to send, sign
 * the payload once, send it with a hard timeout, and persist the outcome.
 *
 * The two re-checks at the top are the point of this function. Publication
 * matched subscriptions against `enabled` at the time the event was published,
 * and the URL was validated when the endpoint was created — but an unbounded
 * amount of time passes before the worker reaches the delivery, during which
 * the endpoint may have been disabled and its URL changed or repointed. The
 * state that matters is the state immediately before the request, so both are
 * re-read here rather than trusted from fan-out or from claim time.
 */

const DISABLED_ENDPOINT_REASON = "Endpoint was disabled before the delivery was attempted.";
const UNSAFE_URL_REASON = "Endpoint URL is not a permitted destination.";

export interface DeliveryExecutionDeps {
  readonly prisma: PrismaClient;
  readonly config: AppConfig;
  readonly logger: Logger;
}

/**
 * Applies D3 (IMPLEMENTATION_PLAN.md section 3) to an outbound result.
 *
 *   2xx                         -> SUCCESS
 *   408, 429, and any 5xx       -> RETRYABLE_FAILURE
 *   timeout, connection failure -> RETRYABLE_FAILURE
 *   every other status          -> PERMANENT_FAILURE
 *
 * 3xx is permanent because redirects are deliberately not followed, so a
 * redirect is a destination this platform will never deliver to. Other 4xx are
 * permanent because a malformed or rejected request will be rejected identically
 * next time; retrying only wastes the budget. 408 and 429 are the two 4xx codes
 * that explicitly mean "try again".
 *
 * `errorMessage` is composed here from platform-controlled text only. No part
 * of the receiver's response body is read, let alone stored.
 */
export function classifyOutboundOutcome(
  outcome: OutboundOutcome,
  timeoutMs: number,
): Pick<DeliveryAttemptRecord, "outcome" | "httpStatusCode" | "errorCategory" | "errorMessage"> {
  if (outcome.kind === "timeout") {
    return {
      outcome: "RETRYABLE_FAILURE",
      httpStatusCode: null,
      errorCategory: "TIMEOUT",
      errorMessage: `No response within the ${timeoutMs}ms delivery timeout.`,
    };
  }

  if (outcome.kind === "connection-error") {
    return {
      outcome: "RETRYABLE_FAILURE",
      httpStatusCode: null,
      errorCategory: "CONNECTION_ERROR",
      errorMessage: `Connection failed (${outcome.code}).`,
    };
  }

  const status = outcome.statusCode;

  if (status >= 200 && status <= 299) {
    return { outcome: "SUCCESS", httpStatusCode: status, errorCategory: null, errorMessage: null };
  }

  const retryable = status === 408 || status === 429 || (status >= 500 && status <= 599);

  return {
    outcome: retryable ? "RETRYABLE_FAILURE" : "PERMANENT_FAILURE",
    httpStatusCode: status,
    errorCategory: "HTTP_STATUS",
    errorMessage: `Receiver responded with HTTP ${status}.`,
  };
}

export async function executeDelivery(
  deps: DeliveryExecutionDeps,
  claimed: ClaimedDelivery,
): Promise<void> {
  const { prisma, config, logger } = deps;

  // The one query in the application that selects `signingSecret`. It is used
  // as an HMAC key and nothing else: it is never logged, never returned, and
  // never persisted onto an attempt.
  const delivery = await prisma.delivery.findUnique({
    where: { id: claimed.id },
    select: {
      id: true,
      endpoint: { select: { id: true, url: true, enabled: true, signingSecret: true } },
      event: {
        select: {
          id: true,
          payload: true,
          createdAt: true,
          eventType: { select: { name: true } },
        },
      },
    },
  });

  if (!delivery) {
    // The event or endpoint was deleted between the claim and this read, and
    // the delivery cascaded away. There is nothing left to transition.
    logger.warn({ deliveryId: claimed.id }, "Claimed delivery no longer exists");
    return;
  }

  const { endpoint, event } = delivery;
  const logContext = {
    deliveryId: delivery.id,
    eventId: event.id,
    endpointId: endpoint.id,
    attemptNumber: claimed.attemptNumber,
  };

  if (!endpoint.enabled) {
    const result = await failDeliveryWithoutAttempt(
      prisma,
      delivery.id,
      claimed.attemptNumber,
      DISABLED_ENDPOINT_REASON,
    );
    if (result.applied) {
      logger.info({ ...logContext, state: "FAILED" }, "Delivery abandoned: endpoint is disabled");
    } else {
      logSuppressedTransition(logger, logContext);
    }
    return;
  }

  try {
    assertSafeEndpointUrl(endpoint.url, config);
  } catch (err) {
    if (!(err instanceof SecurityError)) {
      throw err;
    }
    // Fail closed. The URL passed validation when it was stored, so reaching
    // here means it changed, or the safety rules did. Either way nothing is
    // sent, and no attempt row is written because no request was made.
    const result = await failDeliveryWithoutAttempt(
      prisma,
      delivery.id,
      claimed.attemptNumber,
      UNSAFE_URL_REASON,
    );
    if (result.applied) {
      logger.warn({ ...logContext, state: "FAILED" }, "Delivery abandoned: endpoint URL is not a permitted destination");
    } else {
      logSuppressedTransition(logger, logContext);
    }
    return;
  }

  const attemptedAt = new Date();
  const signed = buildSignedWebhookRequest(
    {
      deliveryId: delivery.id,
      eventId: event.id,
      type: event.eventType.name,
      createdAt: event.createdAt.toISOString(),
      payload: event.payload,
    },
    endpoint.signingSecret,
    attemptedAt,
  );

  logger.info(logContext, "Delivery attempt started");

  // `signed.body` is the exact byte array that was signed, passed through
  // untouched. Nothing re-serializes the payload between here and the socket.
  const outcome = await sendWebhookRequest({
    url: endpoint.url,
    headers: signed.headers,
    body: signed.body,
    timeoutMs: config.deliveryTimeoutMs,
  });

  const classification = classifyOutboundOutcome(outcome, config.deliveryTimeoutMs);

  const result = await completeDeliveryWithAttempt(
    prisma,
    delivery.id,
    {
      attemptNumber: claimed.attemptNumber,
      attemptedAt,
      durationMs: outcome.durationMs,
      ...classification,
    },
    config,
  );

  const completedContext = {
    ...logContext,
    state: result.state,
    statusCode: classification.httpStatusCode,
    durationMs: outcome.durationMs,
  };

  if (!result.applied) {
    // The attempt was still recorded; only the state change was suppressed.
    logSuppressedTransition(logger, logContext);
    return;
  }

  if (result.state === "DELIVERED") {
    logger.info(completedContext, "Delivery succeeded");
  } else if (result.state === "RETRY_SCHEDULED") {
    // A receiver failure is normal system behavior, not an application fault
    // (ARCHITECTURE.md section 30), so it is logged at warn rather than error.
    logger.warn(
      { ...completedContext, outcome: classification.outcome },
      "Delivery failed; retry scheduled",
    );
  } else {
    logger.warn(
      { ...completedContext, outcome: classification.outcome },
      "Delivery failed permanently",
    );
  }
}

/**
 * The delivery changed hands while this attempt was in flight: its lease
 * expired, recovery returned it to a processable state, and another claim took
 * ownership. The fencing guard in the state transitions suppressed this
 * worker's write (see src/modules/deliveries/state-transitions.ts). Expected
 * under recovery rather than exceptional — but never silent, because it means
 * a receiver saw a request whose result the platform did not act on.
 */
function logSuppressedTransition(logger: Logger, logContext: Record<string, unknown>): void {
  logger.warn(logContext, "Delivery changed hands before this attempt completed; state left untouched");
}
