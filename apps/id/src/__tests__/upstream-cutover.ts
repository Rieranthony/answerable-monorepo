import { mkdtemp, mkdir, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { assertDisposableTestDatabase } from "./test-database.ts";

/** Exercise the actual cutover SQL and Drizzle receipt without rewriting history. */
export async function upstreamCutoverFixture() {
  assertDisposableTestDatabase("test upstream credential cutover");
  const folder = await mkdtemp(join(tmpdir(), "id-upstream-cutover-"));
  const migrationsSchema = `cutover_${crypto.randomUUID().replaceAll("-", "")}`;
  const tag = "0037_retire_legacy_upstream_tokens";
  await mkdir(join(folder, "meta"));
  await copyFile(
    new URL(`../../drizzle/${tag}.sql`, import.meta.url),
    join(folder, `${tag}.sql`),
  );
  await Bun.write(
    join(folder, "meta/_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: [{ idx: 0, version: "7", when: 1, tag, breakpoints: true }],
    }),
  );
  return {
    folder,
    migrationsSchema,
    async run(db: Database) {
      await migrate(db, { migrationsFolder: folder, migrationsSchema });
    },
    async receipts(db: Database) {
      const result = await db.execute<{ count: number }>(
        sql`select count(*)::integer as count from ${sql.identifier(migrationsSchema)}.__drizzle_migrations`,
      );
      return result.rows[0]!.count;
    },
    async close(db: Database) {
      await db.execute(
        sql`drop schema if exists ${sql.identifier(migrationsSchema)} cascade`,
      );
      await rm(folder, { recursive: true, force: true });
    },
  };
}
