import { createApp } from "../app.ts";
import { createAuth } from "../auth.ts";
import { createDatabase } from "../db/client.ts";
import { assertRuntimeRole } from "../db/runtime-role.ts";
import type { Environment } from "../env.ts";
import { sql } from "drizzle-orm";
import { assertDisposableTestDatabase } from "./test-database.ts";

const input = JSON.parse(await Bun.stdin.text()) as {
  environment: Environment;
  holdResponse: boolean;
};
assertDisposableTestDatabase(
  "operation crash worker",
  input.environment.databaseUrl,
);
if (!process.send)
  throw new Error("The operation worker requires its test IPC parent");
const connection = createDatabase(input.environment);
await assertRuntimeRole(connection.db);
const pid = await connection.db.execute(sql`select pg_backend_pid() as pid`);
const app = createApp({
  db: connection.db,
  auth: createAuth(connection.db, input.environment),
  environment: input.environment,
});
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const response = await app.fetch(request);
    if (input.holdResponse) {
      process.send!({ stage: "response-ready", status: response.status });
      // The parent kills this process before any response reaches the HTTP caller.
      await Bun.sleep(60_000);
    }
    return response;
  },
});
process.send({
  stage: "ready",
  url: `http://127.0.0.1:${server.port}`,
  databasePid: Number(pid.rows[0]!.pid),
});
