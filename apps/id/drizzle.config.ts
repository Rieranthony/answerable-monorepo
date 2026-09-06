import { defineConfig } from "drizzle-kit";

const databaseUrl = process.env.DATABASE_URL;

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  ...(databaseUrl ? { dbCredentials: { url: databaseUrl } } : {}),
  out: "./drizzle",
  strict: true,
  verbose: true,
});
