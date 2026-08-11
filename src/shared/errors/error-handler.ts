import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "./app-error.ts";

interface ErrorResponseBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId: string;
  };
}

function buildBody(
  code: string,
  message: string,
  requestId: string,
  details?: unknown,
): ErrorResponseBody {
  const body: ErrorResponseBody = { error: { code, message, requestId } };
  if (details !== undefined) {
    body.error.details = details;
  }
  return body;
}

/**
 * Registers the single Fastify error handler and not-found handler.
 *
 * Every error path in the application — thrown AppError subclasses, Fastify
 * schema validation failures, unmatched routes, and genuinely unexpected
 * errors — resolves to exactly one response shape. Unexpected errors are
 * logged with the request id for debugging but never expose their message,
 * stack trace, or any Prisma internals to the client.
 */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof AppError) {
      reply
        .status(error.statusCode)
        .send(buildBody(error.code, error.message, request.id, error.details));
      return;
    }

    if (error.validation) {
      reply
        .status(400)
        .send(buildBody("VALIDATION_ERROR", "Request failed schema validation.", request.id, error.validation));
      return;
    }

    request.log.error({ err: error, requestId: request.id }, "Unhandled error");
    reply.status(500).send(buildBody("INTERNAL_ERROR", "Internal server error", request.id));
  });

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    reply
      .status(404)
      .send(buildBody("NOT_FOUND", "Route not found.", request.id));
  });
}
