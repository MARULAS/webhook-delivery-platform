import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../app/config.ts";
import type { PrismaClient } from "../../infrastructure/database/prisma.ts";
import {
  createEndpointBodySchema,
  endpointIdParamsSchema,
  endpointResponseSchema,
  listEndpointsResponseSchema,
  updateEndpointBodySchema,
} from "./schemas.ts";
import {
  createEndpoint,
  deleteEndpoint,
  getEndpoint,
  listEndpoints,
  updateEndpoint,
  type CreateEndpointInput,
  type UpdateEndpointInput,
} from "./service.ts";

interface EndpointIdParams {
  endpointId: string;
}

export function registerEndpointRoutes(app: FastifyInstance, prisma: PrismaClient, config: AppConfig): void {
  app.post<{ Body: CreateEndpointInput }>(
    "/endpoints",
    {
      schema: {
        description: "Registers a webhook endpoint. Generates a signing secret server-side; it is never returned.",
        tags: ["endpoints"],
        body: createEndpointBodySchema,
        response: { 201: endpointResponseSchema },
      },
    },
    async (request, reply) => {
      const endpoint = await createEndpoint(prisma, config, request.body);
      reply.status(201);
      return endpoint;
    },
  );

  app.get(
    "/endpoints",
    {
      schema: {
        description: "Lists all webhook endpoints.",
        tags: ["endpoints"],
        response: { 200: listEndpointsResponseSchema },
      },
    },
    async () => listEndpoints(prisma),
  );

  app.get<{ Params: EndpointIdParams }>(
    "/endpoints/:endpointId",
    {
      schema: {
        description: "Fetches a webhook endpoint by id.",
        tags: ["endpoints"],
        params: endpointIdParamsSchema,
        response: { 200: endpointResponseSchema },
      },
    },
    async (request) => getEndpoint(prisma, request.params.endpointId),
  );

  app.patch<{ Params: EndpointIdParams; Body: UpdateEndpointInput }>(
    "/endpoints/:endpointId",
    {
      schema: {
        description:
          "Updates a webhook endpoint. Also used to disable/re-enable it by setting `enabled`; there is no separate disable route.",
        tags: ["endpoints"],
        params: endpointIdParamsSchema,
        body: updateEndpointBodySchema,
        response: { 200: endpointResponseSchema },
      },
    },
    async (request) => updateEndpoint(prisma, config, request.params.endpointId, request.body),
  );

  app.delete<{ Params: EndpointIdParams }>(
    "/endpoints/:endpointId",
    {
      schema: {
        description: "Deletes a webhook endpoint and, by cascade, its subscriptions.",
        tags: ["endpoints"],
        params: endpointIdParamsSchema,
        response: { 204: { type: "null" } },
      },
    },
    async (request, reply) => {
      await deleteEndpoint(prisma, request.params.endpointId);
      reply.status(204);
    },
  );
}
