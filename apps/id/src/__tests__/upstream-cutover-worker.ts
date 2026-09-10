import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import { createDatabase } from "../db/client.ts";
import type { Environment } from "../env.ts";
import { assertDisposableTestDatabase } from "./test-database.ts";

const input = JSON.parse(await Bun.stdin.text()) as {
  environment: Environment;
  folder: string;
  migrationsSchema: string;
};
assertDisposableTestDatabase(
  "cutover crash worker",
  input.environment.databaseUrl,
);
if (!process.send)
  throw new Error("Cutover worker requires its test IPC parent");
const connection = createDatabase(input.environment);
const pid = await connection.db.execute(sql`select pg_backend_pid() as pid`);
process.send({ stage: "ready", pid: Number(pid.rows[0]!.pid) });
await migrate(connection.db, {
  migrationsFolder: input.folder,
  migrationsSchema: input.migrationsSchema,
});
process.send({ stage: "committed" });
// Parent kills this process before normal command completion can be observed.
await Bun.sleep(60_000);
await connection.close();
