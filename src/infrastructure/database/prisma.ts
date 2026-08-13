import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../../generated/prisma/client.ts";
import type { AppConfig } from "../../app/config.ts";

/**
 * The single PrismaClient instance for the process, built with the pg
 * adapter (required by Prisma 7's driver-adapter model). Application code
 * should import `prisma` from this module rather than instantiating its own
 * client.
 *
 * `connectionTimeoutMillis` is set explicitly because the pg default is `0`,
 * meaning a query waits forever for a free connection when the pool is
 * saturated. That default is not survivable for the delivery worker: a
 * delivery whose database work stalls indefinitely keeps running past its
 * processing lease, and the recovery sweep then hands the row to another
 * worker while the first is still live — the receiver gets the same webhook
 * twice. Failing fast turns that into an ordinary error the worker isolates,
 * logs, and recovers from. The bound comes from the same constant the lease
 * derivation is built on (src/app/config.ts).
 */
export function createPrismaClient(config: AppConfig): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: config.databaseConnectionTimeoutMs,
  });
  return new PrismaClient({ adapter });
}

export async function connectDatabase(client: PrismaClient): Promise<void> {
  await client.$connect();
}

export async function disconnectDatabase(client: PrismaClient): Promise<void> {
  await client.$disconnect();
}

/**
 * Reports whether the database is currently reachable by performing a real
 * round-trip query rather than trusting a cached connection flag. `$connect`
 * alone would not detect a database that has become unreachable after the
 * initial connection succeeded.
 *
 * This is the one place in the codebase that uses raw SQL outside the
 * worker's delivery-claiming query. It is a fixed, parameterless liveness
 * probe (not a data-access query), and it exists only because Part 1 defines
 * no Prisma models to query through the normal client API. Do not treat this
 * as a precedent for using raw SQL where a Prisma model call would work.
 */
export async function checkDatabase(
  client: PrismaClient,
  timeoutMs = 2000,
): Promise<boolean> {
  try {
    await Promise.race([
      client.$queryRaw`SELECT 1`,
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error("Database health check timed out")), timeoutMs);
      }),
    ]);
    return true;
  } catch {
    return false;
  }
}

export type { PrismaClient };
