import { defineConfig, env } from "prisma/config";

// Prisma 7 moved datasource configuration out of schema.prisma into this
// file; the schema's datasource block can no longer read env() directly.
// `env()` resolves DATABASE_URL from process.env and fails fast if it is
// missing, matching this project's "no silent defaults" configuration rule.
// Run Prisma CLI commands with a populated `.env` (see .env.example) or with
// DATABASE_URL already exported, e.g.:
//   node --env-file-if-exists=.env node_modules/.bin/prisma <command>
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
