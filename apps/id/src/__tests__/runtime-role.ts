import { sql } from "drizzle-orm";
import { createDatabase, type Database } from "../db/client.ts";
import { configureRuntimeRole } from "../db/runtime-role.ts";
import type { Environment } from "../env.ts";
import { assertDisposableTestDatabase } from "./test-database.ts";

/** A fresh restricted runtime role that can log in, and a pool connected as it. */
export async function createRuntimeLogin(
  owner: Database,
  environment: Environment,
  overrides: Partial<Environment> = {},
) {
  const role = `id_test_runtime_${crypto.randomUUID().replaceAll("-", "")}`;
  await configureRuntimeRole(owner, role);
  // ALTER ROLE takes no parameters; the role and the password are generated here.
  const password = crypto.randomUUID().replaceAll("-", "");
  await owner.execute(
    sql.raw(`alter role "${role}" login password '${password}'`),
  );
  const url = new URL(environment.databaseUrl);
  url.username = role;
  url.password = password;
  const settings = {
    ...environment,
    ...overrides,
    databaseUrl: url.toString(),
  };
  const connection = createDatabase(settings);
  return {
    role,
    /** The environment the connection uses, with the login's URL. */
    environment: settings,
    connection,
    /** Close the connection, then remove the role and what it owns. */
    async drop() {
      await connection.close();
      await owner.execute(sql`drop owned by ${sql.identifier(role)}`);
      await owner.execute(sql`drop role ${sql.identifier(role)}`);
    },
  };
}

export type RuntimeLogin = Awaited<ReturnType<typeof createRuntimeLogin>>;

/** A fresh restricted runtime login next to the owner connection that seeds. */
export async function openRuntimeRole(environment: Environment) {
  assertDisposableTestDatabase("runtime role proof");
  const owner = createDatabase(environment);
  await owner.db.execute(
    sql`truncate audit_events, organizations, users, oauth_clients, oauth_resources cascade`,
  );
  const login = await createRuntimeLogin(owner.db, environment, {
    databasePoolMax: 2,
  });
  return {
    owner,
    runtime: login.connection,
    role: login.role,
    async close() {
      await login.drop();
      await owner.close();
    },
  };
}
