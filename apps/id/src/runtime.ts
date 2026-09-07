import { createApp } from "./app.ts";
import { bootstrap, systemActor } from "./bootstrap.ts";
import { createAuth } from "./auth.ts";
import { createDatabase } from "./db/client.ts";
import type { Environment } from "./env.ts";

export async function startRuntime(
  environment: Environment,
  {
    seed = bootstrap,
    databaseFactory = createDatabase,
    authFactory = createAuth,
    appFactory = createApp,
    serve = Bun.serve,
  }: {
    seed?: typeof bootstrap;
    databaseFactory?: typeof createDatabase;
    authFactory?: typeof createAuth;
    appFactory?: typeof createApp;
    serve?: typeof Bun.serve;
  } = {},
) {
  const database = databaseFactory(environment);
  let seeded;
  try {
    seeded = await seed(database.db, systemActor("startup"), {
      platformOrganizationSlug: environment.platformOrganizationSlug,
      platformOrganizationName: environment.platformOrganizationName,
      adminResourceIdentifier: environment.adminResourceIdentifier,
    });
  } catch (error) {
    await database.close();
    throw error;
  }
  const summary = Object.entries(seeded)
    .map(
      ([row, result]) =>
        `${row}: created=${result.created}, updated=${"updated" in result ? result.updated : false}`,
    )
    .join("; ");
  console.log(
    `[id] seeded platform organisation ${seeded.organization.slug} (${summary})`,
  );
  const auth = authFactory(database.db, environment);
  const app = appFactory({ auth, db: database.db, environment });
  const server = serve({
    port: environment.port,
    fetch: app.fetch,
  });
  let isShuttingDown = false;

  async function shutdown(): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown = true;

    server.stop(false);
    await database.close();
  }

  return { database, server, shutdown };
}
