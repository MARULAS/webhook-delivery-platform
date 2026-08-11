import { randomBytes } from "node:crypto";
import { Prisma } from "../../../generated/prisma/client.ts";
import type { PrismaClient } from "../../infrastructure/database/prisma.ts";
import { assertSafeEndpointUrl, type UrlSafetyConfig } from "../../infrastructure/security/url-safety.ts";
import { NotFoundError } from "../../shared/errors/app-error.ts";

/**
 * Endpoint management (SPEC.md section 6, IMPLEMENTATION_PLAN.md Part 2).
 *
 * Every query that can feed an API response selects `PUBLIC_SELECT` only —
 * `signingSecret` is never fetched here, so it cannot leak through a
 * response even if a caller forgot to strip it. The secret itself is
 * generated once, at creation, with `crypto.randomBytes` (a CSPRNG) and is
 * otherwise only read by the (not-yet-implemented) delivery worker.
 *
 * Disabling an endpoint is not a separate route: PATCH accepts `enabled`
 * like any other field, so there is exactly one update path to review and
 * test rather than two overlapping ones.
 */

const PUBLIC_SELECT = {
  id: true,
  name: true,
  url: true,
  enabled: true,
  createdAt: true,
  updatedAt: true,
} as const;

export interface EndpointResponse {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateEndpointInput {
  name: string;
  url: string;
  enabled?: boolean;
}

export interface UpdateEndpointInput {
  name?: string;
  url?: string;
  enabled?: boolean;
}

export async function createEndpoint(
  prisma: PrismaClient,
  urlSafetyConfig: UrlSafetyConfig,
  input: CreateEndpointInput,
): Promise<EndpointResponse> {
  assertSafeEndpointUrl(input.url, urlSafetyConfig);

  const signingSecret = randomBytes(32).toString("hex");

  return prisma.webhookEndpoint.create({
    data: {
      name: input.name,
      url: input.url,
      signingSecret,
      enabled: input.enabled ?? true,
    },
    select: PUBLIC_SELECT,
  });
}

export async function getEndpoint(prisma: PrismaClient, endpointId: string): Promise<EndpointResponse> {
  const endpoint = await prisma.webhookEndpoint.findUnique({
    where: { id: endpointId },
    select: PUBLIC_SELECT,
  });
  if (!endpoint) {
    throw new NotFoundError("Webhook endpoint not found.");
  }
  return endpoint;
}

export async function listEndpoints(prisma: PrismaClient): Promise<EndpointResponse[]> {
  return prisma.webhookEndpoint.findMany({
    select: PUBLIC_SELECT,
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Re-validates the URL whenever the caller supplies one, regardless of
 * whether it differs from the stored value — the check is cheap, and this
 * avoids relying on a diff to decide whether safety must be re-checked.
 */
export async function updateEndpoint(
  prisma: PrismaClient,
  urlSafetyConfig: UrlSafetyConfig,
  endpointId: string,
  input: UpdateEndpointInput,
): Promise<EndpointResponse> {
  if (input.url !== undefined) {
    assertSafeEndpointUrl(input.url, urlSafetyConfig);
  }

  try {
    return await prisma.webhookEndpoint.update({
      where: { id: endpointId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.url !== undefined ? { url: input.url } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      },
      select: PUBLIC_SELECT,
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      throw new NotFoundError("Webhook endpoint not found.");
    }
    throw err;
  }
}

export async function deleteEndpoint(prisma: PrismaClient, endpointId: string): Promise<void> {
  try {
    // Subscriptions cascade at the database level (onDelete: Cascade in
    // prisma/schema.prisma) — a subscription without its endpoint is
    // meaningless, so this is the single, consistent deletion rule.
    await prisma.webhookEndpoint.delete({ where: { id: endpointId } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      throw new NotFoundError("Webhook endpoint not found.");
    }
    throw err;
  }
}
