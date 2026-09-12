import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import { createDatabase } from "../db/client.ts";
import { testEnvironment } from "./support.ts";
import { assertDisposableTestDatabase } from "./test-database.ts";

assertDisposableTestDatabase("migration interruption worker");
if (!process.send)
  throw new Error("Migration worker requires its test IPC parent");
const connection = createDatabase(testEnvironment());
try {
  const pid = await connection.db.execute(sql`select pg_backend_pid() as pid`);
  process.send({ stage: "ready", pid: Number(pid.rows[0]!.pid) });
  await migrate(connection.db, { migrationsFolder: process.argv[2]! });
  process.send({ stage: "committed" });
  // The parent terminates us before normal process completion, after observing commit.
  await Bun.sleep(30_000);
} finally {
  await connection.close();
}
