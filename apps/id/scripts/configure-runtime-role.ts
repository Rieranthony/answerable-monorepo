import { z } from "zod";
import { createDatabase } from "../src/db/client.ts";
import { configureRuntimeRole } from "../src/db/runtime-role.ts";

const migrationUrl = z.url().parse(Bun.env.DATABASE_MIGRATION_URL);
const roleName = process.argv[2] ?? "answerable_id_runtime";
const connection = createDatabase({
  databaseUrl: migrationUrl,
  databasePoolMax: 1,
  databasePoolIdleTimeoutMs: 1000,
  databaseConnectionTimeoutMs: 5000,
  nodeEnv: "production",
});
try {
  await configureRuntimeRole(connection.db, roleName);
  console.log(
    `Configured runtime permissions for ${roleName}. Provision login credentials separately.`,
  );
} finally {
  await connection.close();
}
