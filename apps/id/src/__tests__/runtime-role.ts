import { sql } from "drizzle-orm";
import { createDatabase, type DatabaseConnection } from "../db/client.ts";
import { configureRuntimeRole } from "../db/runtime-role.ts";
import type { Environment } from "../env.ts";
import { assertDisposableTestDatabase } from "./test-database.ts";

export type RuntimeRoleConnections = {
  owner: DatabaseConnection;
  runtime: DatabaseConnection;
};

/** A fresh restricted runtime login next to the owner connection that seeds. */
export async function openRuntimeRole(
  environment: Environment,
  roleName: string,
): Promise<RuntimeRoleConnections> {
  assertDisposableTestDatabase("runtime role proof");
  const owner = createDatabase(environment);
  await owner.db.execute(
    sql`truncate audit_events, organizations, users, oauth_clients, oauth_resources cascade`,
  );
  await configureRuntimeRole(owner.db, roleName);
  const password = crypto.randomUUID().replaceAll("-", "");
  await owner.db.execute(
    sql.raw(`alter role "${roleName}" login password '${password}'`),
  );
  const url = new URL(environment.databaseUrl);
  url.username = roleName;
  url.password = password;
  const runtime = createDatabase({
    ...environment,
    databaseUrl: url.toString(),
    databasePoolMax: 2,
  });
  return { owner, runtime };
}

export async function closeRuntimeRole(
  connections: Partial<RuntimeRoleConnections>,
  roleName: string,
) {
  await connections.runtime?.close();
  if (!connections.owner) return;
  await connections.owner.db.execute(
    sql`drop owned by ${sql.identifier(roleName)}`,
  );
  await connections.owner.db.execute(
    sql`drop role ${sql.identifier(roleName)}`,
  );
  await connections.owner.close();
}
