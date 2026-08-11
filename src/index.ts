import { buildServer } from "./app/server.ts";
import { startApplication } from "./app/lifecycle.ts";
import { createPrismaClient } from "./infrastructure/database/prisma.ts";

/**
 * Config is loaded dynamically so that a validation failure (thrown while
 * evaluating app/config.ts) rejects this function instead of crashing the
 * process with an uncaught-exception stack trace. Every other module only
 * imports config's types, which are erased at compile time and never
 * trigger this evaluation.
 */
async function main(): Promise<void> {
  const { config } = await import("./app/config.ts");

  const prisma = createPrismaClient(config);
  const app = await buildServer(config, prisma);

  await startApplication(app, prisma, config);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Failed to start application: ${message}\n`);
  process.exit(1);
});
