import { z } from "zod";
import { createDatabase } from "../src/db/client.ts";
import { loadEnvironment } from "../src/env.ts";
import { bindExistingSystem } from "../src/services/system-binding.ts";

// Positional UUIDs deliberately avoid discovering authority from names.
const ids = z
  .tuple([z.uuid(), z.uuid(), z.uuid()])
  .safeParse(process.argv.slice(2));
if (!ids.success)
  throw new Error(
    "Usage: bun scripts/bind-system.ts <organisation UUID> <admin resource UUID> <platform-admins group UUID>",
  );
const [organizationId, resourceId, groupId] = ids.data;
const environment = loadEnvironment();
const connection = createDatabase(environment);
try {
  console.log(
    JSON.stringify(
      await bindExistingSystem(
        connection.db,
        {
          actorType: "system",
          actorId: "system-binding-migration",
          requestId: crypto.randomUUID(),
        },
        {
          organizationId,
          resourceId,
          groupId,
          resourceIdentifier: environment.adminResourceIdentifier,
        },
      ),
    ),
  );
} finally {
  await connection.close();
}
