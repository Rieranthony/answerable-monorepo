import { createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import { createDatabase } from "./db/client.ts";
import type { Environment } from "./env.ts";

export function startRuntime(environment: Environment) {
  const database = createDatabase(environment);
  const auth = createAuth(database.db, environment);
  const app = createApp({ auth, db: database.db, environment });
  const server = Bun.serve({
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
