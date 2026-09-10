import { z } from "zod";
import { createDatabase } from "../src/db/client.ts";
import { purgeOperationResults } from "../src/services/operation-retention.ts";

const connection = createDatabase({
  databaseUrl: z.url().parse(Bun.env.DATABASE_RETENTION_URL),
  databasePoolMax: 1,
  databasePoolIdleTimeoutMs: 1000,
  databaseConnectionTimeoutMs: 5000,
  nodeEnv: "production",
});
try {
  console.log(
    `Purged ${await purgeOperationResults(connection.db)} expired operation results.`,
  );
} finally {
  await connection.close();
}
