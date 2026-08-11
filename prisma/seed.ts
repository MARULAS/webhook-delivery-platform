import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.ts";

/**
 * Seeds the fixed event type catalog (D1, IMPLEMENTATION_PLAN.md section 3:
 * EventType is a small persisted, seeded table, not a public CRUD resource).
 * Uses upsert so the script is idempotent and safe to re-run.
 *
 * This is a standalone operational script under prisma/, not application
 * runtime code, so — like prisma.config.ts — it reads DATABASE_URL directly
 * rather than through src/app/config.ts, which governs the application
 * process only.
 *
 * The catalog below is a small, representative fixed set (SPEC.md section 6
 * gives these as examples); it does not need to be exhaustive.
 */
const EVENT_TYPES = ["order.created", "order.completed", "payment.failed", "user.registered"] as const;

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to run the seed script.");
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });

  try {
    for (const name of EVENT_TYPES) {
      await prisma.eventType.upsert({
        where: { name },
        update: {},
        create: { name },
      });
    }
    process.stdout.write(`Seeded ${EVENT_TYPES.length} event types.\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Seed failed: ${message}\n`);
  process.exit(1);
});
