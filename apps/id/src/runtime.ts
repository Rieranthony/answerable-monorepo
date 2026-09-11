import { createApp } from "./app.ts";
import { maxRequestBodyBytes } from "./http/request-limits.ts";
import { bootstrap, systemActor } from "./bootstrap.ts";
import { createAuth } from "./auth.ts";
import { createDatabase } from "./db/client.ts";
import type { Environment } from "./env.ts";
import { assertRuntimeRole } from "./db/runtime-role.ts";
import { createOperationalMetrics } from "./operations/metrics.ts";

export async function startRuntime(
  environment: Environment,
  {
    seed = bootstrap,
    databaseFactory = createDatabase,
    authFactory = createAuth,
    appFactory = createApp,
    serve = Bun.serve,
    verifyDatabaseRole = assertRuntimeRole,
  }: {
    seed?: typeof bootstrap;
    databaseFactory?: typeof createDatabase;
    authFactory?: typeof createAuth;
    appFactory?: typeof createApp;
    serve?: typeof Bun.serve;
    verifyDatabaseRole?: typeof assertRuntimeRole;
  } = {},
) {
  const database = databaseFactory(environment);
  let server: Bun.Server<undefined>;
  const metrics = createOperationalMetrics(database.pool);
  try {
    if (environment.nodeEnv !== "test") await verifyDatabaseRole(database.db);
    const seeded = await seed(database.db, systemActor("startup"), {
      platformOrganizationSlug: environment.platformOrganizationSlug,
      platformOrganizationName: environment.platformOrganizationName,
      adminResourceIdentifier: environment.adminResourceIdentifier,
    });
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
    const app = appFactory({ auth, db: database.db, environment, metrics });
    server = serve({
      port: environment.port,
      maxRequestBodySize: maxRequestBodyBytes,
      fetch: app.fetch,
    });
  } catch (error) {
    await database.close();
    throw error;
  }
  let isShuttingDown = false;
  const reporter =
    environment.operationalLogIntervalMs > 0
      ? setInterval(
          () =>
            console.log("[id] operations", JSON.stringify(metrics.snapshot())),
          environment.operationalLogIntervalMs,
        )
      : undefined;
  reporter?.unref();

  async function shutdown(): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown = true;
    clearInterval(reporter);

    server.stop(false);
    await database.close();
  }

  return { database, server, shutdown, metrics };
}
