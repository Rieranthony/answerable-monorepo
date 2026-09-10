import { z } from "zod";
import { createDatabase } from "../src/db/client.ts";
import { configureRetentionRole } from "../src/db/runtime-role.ts";

const connection = createDatabase({
  databaseUrl: z.url().parse(Bun.env.DATABASE_MIGRATION_URL),
  databasePoolMax: 1,
  databasePoolIdleTimeoutMs: 1000,
  databaseConnectionTimeoutMs: 5000,
  nodeEnv: "production",
});
const roleName = process.argv[2] ?? "answerable_id_retention";
try {
  await configureRetentionRole(connection.db, roleName);
  console.log(
    `Configured retention permissions for ${roleName}. Provision login credentials separately.`,
  );
} finally {
  await connection.close();
}
