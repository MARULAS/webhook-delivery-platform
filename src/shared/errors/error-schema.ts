/**
 * The OpenAPI/response-serialization shape of the shared error body produced
 * by `registerErrorHandling` (error-handler.ts): `{ error: { code, message,
 * details?, requestId } }`. This is the one error shape the whole API uses,
 * so it is defined once here and referenced by every route's `response`
 * object for the status codes that route can actually return, rather than
 * duplicated per module or left undocumented (SPEC.md section 22).
 *
 * This is a plain exported schema object, not a Fastify-registered
 * `$id`/`$ref` — the same style every module's `schemas.ts` already uses for
 * its own response shapes. Fastify still uses it to serialize the actual
 * error response for the status codes it is attached to (not only to
 * document them), so it must stay in sync with `buildBody` in
 * error-handler.ts.
 */
export const errorResponseSchema = {
  type: "object",
  properties: {
    error: {
      type: "object",
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        // Present only for some errors (e.g. AJV validation failures); shape
        // varies by error category, so it is deliberately left unconstrained
        // rather than modeled field-by-field.
        details: {},
        requestId: { type: "string" },
      },
      required: ["code", "message", "requestId"],
      additionalProperties: false,
    },
  },
  required: ["error"],
  additionalProperties: false,
} as const;
