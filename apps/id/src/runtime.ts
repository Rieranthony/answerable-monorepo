import { createApp } from "./app.ts";
import { maxRequestBodyBytes } from "./http/request-limits.ts";
import { bootstrap, systemActor } from "./bootstrap.ts";
import { createAuth, type Auth } from "./auth.ts";
import { createDatabase, type Database } from "./db/client.ts";
import { jwks } from "./db/schema/index.ts";
import type { Environment } from "./env.ts";
import { assertRuntimeRole } from "./db/runtime-role.ts";
import { createOperationalMetrics } from "./operations/metrics.ts";
import { startProtocolSweep } from "./operations/protocol-sweep.ts";
import { symmetricDecrypt } from "better-auth/crypto";
import { desc } from "drizzle-orm";

/**
 * Better Auth decrypts a signing key only when it signs, so a wrong application
 * secret would start, report ready and fail every issuance. Decrypt the key it
 * will sign with first; a database with no key yet passes.
 */
export async function assertSigningKeyReadable(db: Database, auth: Auth) {
  const [newest] = await db
    .select({ privateKey: jwks.privateKey })
    .from(jwks)
    .orderBy(desc(jwks.createdAt), desc(jwks.id))
    .limit(1);
  if (!newest) return;
  const { secretConfig } = await auth.$context;
  try {
    await symmetricDecrypt({
      key: secretConfig,
      data: JSON.parse(newest.privateKey),
    });
  } catch {
    // The message names the cause and never quotes key material.
    throw Object.assign(
      new Error(
        "The configured application secrets cannot decrypt the newest signing key",
      ),
      { name: "SigningKeyCustodyError" },
    );
  }
}

export async function startRuntime(
  environment: Environment,
  {
    allowTestEnvironment = false,
    seed = bootstrap,
    databaseFactory = createDatabase,
    authFactory = createAuth,
    signingKeyCheck = assertSigningKeyReadable,
  }: {
    /** Tests only: NODE_ENV=test drops Better Auth's origin checks and the role check. */
    allowTestEnvironment?: boolean;
    seed?: typeof bootstrap;
    databaseFactory?: typeof createDatabase;
    authFactory?: typeof createAuth;
    /** Tests with a stub auth have no secrets to check. */
    signingKeyCheck?: typeof assertSigningKeyReadable;
  } = {},
) {
  if (environment.nodeEnv === "test" && !allowTestEnvironment)
    throw new Error(
      "NODE_ENV=test is for the test suite: it turns off Better Auth's origin checks and the runtime role check",
    );
  const database = databaseFactory(environment);
  let server: Bun.Server<undefined>;
  const metrics = createOperationalMetrics(database.pool);
  try {
    if (environment.nodeEnv !== "test") await assertRuntimeRole(database.db);
    const seeded = await seed(database.db, systemActor("startup"), {
      platformOrganizationSlug: environment.platformOrganizationSlug,
      platformOrganizationName: environment.platformOrganizationName,
      adminResourceIdentifier: environment.adminResourceIdentifier,
    });
    console.log(
      `[id] platform organisation ${seeded.slug}: ${seeded.created ? "provisioned" : "verified"}`,
    );
    console.log(
      "[id] platform applications",
      JSON.stringify({
        google: Boolean(environment.platformApplications.google),
        microsoft: Boolean(environment.platformApplications.microsoft),
      }),
    );
    const auth = authFactory(database.db, environment);
    await signingKeyCheck(database.db, auth);
    const app = createApp({ auth, db: database.db, environment, metrics });
    server = Bun.serve({
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
  const sweep = startProtocolSweep(database.db, {
    intervalMs: environment.protocolSweepIntervalMs,
    batchSize: environment.protocolSweepBatchSize,
  });

  async function shutdown(): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown = true;
    clearInterval(reporter);

    await server.stop();
    await sweep.stop();
    await database.close();
  }

  return { database, server, shutdown, metrics };
}
