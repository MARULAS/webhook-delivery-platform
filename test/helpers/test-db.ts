import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client.ts";
import { loadConfig, type AppConfig } from "../../src/app/config.ts";

/**
 * Shared test-database wiring for integration tests. Real PostgreSQL, no
 * mocks (focused-testing skill). Point DATABASE_URL at a dedicated test
 * database before running the suite, e.g.:
 *   DATABASE_URL="postgresql://webhooks:webhooks@localhost:5432/webhooks_test?schema=public" npm test
 */

export function testConfig(overrides: Partial<Record<string, string>> = {}): AppConfig {
  return loadConfig({ ...process.env, ...overrides });
}

export function createTestPrisma(config: AppConfig = testConfig()): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: config.databaseUrl }) });
}

/**
 * Clears the rows tests create, in foreign-key order (children first) so the
 * deletes do not depend on cascade behavior that a test may be asserting.
 * The seeded EventType catalog is left alone; `ensureEventTypes` upserts
 * into it, so tests do not depend on prisma/seed.ts having been run.
 */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.deliveryAttempt.deleteMany();
  await prisma.delivery.deleteMany();
  await prisma.event.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.webhookEndpoint.deleteMany();
}

export async function ensureEventTypes(prisma: PrismaClient, names: readonly string[]): Promise<void> {
  for (const name of names) {
    await prisma.eventType.upsert({ where: { name }, update: {}, create: { name } });
  }
}
