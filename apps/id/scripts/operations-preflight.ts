import { createDatabase } from "../src/db/client.ts";
import {
  assertRuntimeRole,
  unsafeRuntimeRole,
} from "../src/db/runtime-role.ts";
import { loadEnvironment } from "../src/env.ts";
import {
  checkKeyCustody,
  custodyErrorName,
} from "../src/operations/preflight.ts";

let connection: ReturnType<typeof createDatabase> | undefined;
try {
  const environment = loadEnvironment();
  connection = createDatabase({ ...environment, databasePoolMax: 1 });
  await assertRuntimeRole(connection.db);
  const counts = await checkKeyCustody(connection.db, environment);
  console.log(
    JSON.stringify({
      event: "custody_preflight_passed",
      ...counts,
      scope: "current_database_only",
    }),
  );
} catch (error) {
  // Only these failures have messages known to carry no secret or key material.
  const known =
    error instanceof Error &&
    (error.name === custodyErrorName || error.message === unsafeRuntimeRole);
  console.error(
    JSON.stringify({
      event: "custody_preflight_failed",
      ...(known ? { reason: error.message } : {}),
    }),
  );
  process.exitCode = 1;
} finally {
  await connection?.close();
}
