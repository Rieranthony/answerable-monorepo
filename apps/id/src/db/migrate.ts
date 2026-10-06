import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import type { Database } from "./client.ts";

const committedFolder = fileURLToPath(
  new URL("../../drizzle", import.meta.url),
);

/**
 * Applies the pending migrations in one transaction. Drizzle's migrator records each
 * file's hash and journal time but compares neither: it skips every file whose time is
 * not after the last receipt, so an applied file that was edited is silently ignored, and
 * a regenerated one runs again. Refuse instead, naming the file.
 */
export async function runMigrations(
  db: Database,
  migrationsFolder = committedFolder,
): Promise<void> {
  const files = readMigrationFiles({ migrationsFolder });
  const { entries } = JSON.parse(
    await readFile(`${migrationsFolder}/meta/_journal.json`, "utf8"),
  ) as { entries: { tag: string }[] };
  const {
    rows: [present],
  } = await db.execute<{ applied: boolean }>(
    sql`select to_regclass('drizzle.__drizzle_migrations') is not null as applied`,
  );
  const receipts = present!.applied
    ? (
        await db.execute<{ hash: string; created_at: string }>(
          sql`select hash, created_at::text from drizzle.__drizzle_migrations order by id`,
        )
      ).rows
    : [];
  for (const [index, receipt] of receipts.entries()) {
    const file = files[index];
    if (
      file?.hash === receipt.hash &&
      String(file.folderMillis) === receipt.created_at
    )
      continue;
    const name = entries[index]
      ? `drizzle/${entries[index].tag}.sql`
      : `the file applied as migration ${index + 1}`;
    throw new Error(
      `Refusing to migrate: ${name} is not the migration this database applied. Restore the applied file, or recreate a disposable database.`,
    );
  }
  await migrate(db, { migrationsFolder });
}
