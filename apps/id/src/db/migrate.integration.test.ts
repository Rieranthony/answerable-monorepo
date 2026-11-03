import { afterAll, expect, spyOn, test } from "bun:test";
import {
  appendFile,
  cp,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";

import { testEnvironment } from "../__tests__/support.ts";
import { testDatabaseUrl } from "../__tests__/test-database.ts";
import { createDatabase } from "./client.ts";
import { runMigrations } from "./migrate.ts";

const connection = createDatabase(testEnvironment());
const committed = fileURLToPath(new URL("../../drizzle", import.meta.url));
const committedCount = readMigrationFiles({
  migrationsFolder: committed,
}).length;
afterAll(() => connection.close());

async function editJournal(
  folder: string,
  edit: (entries: { tag: string; when: number }[]) => void,
) {
  const path = join(folder, "meta/_journal.json");
  const journal = JSON.parse(await readFile(path, "utf8"));
  edit(journal.entries);
  await writeFile(path, JSON.stringify(journal));
}

const receipts = async () =>
  (
    await connection.db.execute(
      sql`select hash, created_at from drizzle.__drizzle_migrations order by id`,
    )
  ).rows;

test.each([
  [
    "an applied file was edited",
    "drizzle/0001_invariants.sql",
    (folder: string) =>
      appendFile(join(folder, "0001_invariants.sql"), "\n-- edited\n"),
  ],
  [
    "an applied file was regenerated with a new journal time",
    "drizzle/0000_initial.sql",
    (folder: string) =>
      editJournal(folder, (entries) => {
        entries[0]!.when += 1;
      }),
  ],
  [
    "an applied file was removed from before a later one",
    "drizzle/0001_invariants.sql",
    (folder: string) =>
      editJournal(folder, (entries) => {
        entries.shift();
      }),
  ],
])("migration refuses, naming the file, when %s", async (_, file, change) => {
  const folder = await mkdtemp(join(tmpdir(), "id-migrations-"));
  try {
    await cp(committed, folder, { recursive: true });
    await change(folder);
    const applied = await receipts();
    await expect(runMigrations(connection.db, folder)).rejects.toThrow(
      `Refusing to migrate: ${file} is not the migration this database applied`,
    );
    expect(await receipts()).toEqual(applied);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test.each([
  ["the last migration", 1],
  ["every migration", committedCount],
])(
  "migration accepts a database that has applied more than the image carries: %s missing",
  async (_, missing) => {
    const folder = await mkdtemp(join(tmpdir(), "id-migrations-"));
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await cp(committed, folder, { recursive: true });
      await editJournal(folder, (entries) => {
        entries.splice(entries.length - missing, missing);
      });
      const applied = await receipts();
      expect(applied).toHaveLength(committedCount);
      expect(await runMigrations(connection.db, folder)).toEqual({
        ahead: true,
      });
      expect(await receipts()).toEqual(applied);
      expect(log.mock.calls).toEqual([
        [
          `The database has applied ${committedCount} migrations and this image carries ${committedCount - missing}; applying nothing.`,
        ],
      ]);
    } finally {
      log.mockRestore();
      await rm(folder, { recursive: true, force: true });
    }
  },
);

test("migration says nothing when the database and the image agree", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    expect(await runMigrations(connection.db)).toEqual({ ahead: false });
    expect(log).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});

test("a database that is ahead still refuses a shared file that changed", async () => {
  const folder = await mkdtemp(join(tmpdir(), "id-migrations-"));
  try {
    await cp(committed, folder, { recursive: true });
    await editJournal(folder, (entries) => {
      entries.pop();
    });
    await appendFile(join(folder, "0000_initial.sql"), "\n-- edited\n");
    const applied = await receipts();
    await expect(runMigrations(connection.db, folder)).rejects.toThrow(
      "Refusing to migrate: drizzle/0000_initial.sql is not the migration this database applied",
    );
    expect(await receipts()).toEqual(applied);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("migrating a database at 0001 leaves its provider rows as they were, as directories", async () => {
  const name = `answerable_id_forward_${crypto.randomUUID().replaceAll("-", "")}`;
  const folder = await mkdtemp(join(tmpdir(), "id-migrations-"));
  const log = spyOn(console, "log").mockImplementation(() => {});
  await connection.pool.query(`create database ${name}`);
  const url = new URL(testDatabaseUrl);
  url.pathname = `/${name}`;
  const scratch = createDatabase(
    testEnvironment({ databaseUrl: url.toString() }),
  );
  const rows = async () =>
    (
      await scratch.pool.query<Record<string, unknown>>(
        "select *, xmin::text as tuple_writer from sso_providers order by id",
      )
    ).rows;
  try {
    await cp(committed, folder, { recursive: true });
    await editJournal(folder, (entries) => {
      entries.splice(2);
    });
    expect(await runMigrations(scratch.db, folder)).toEqual({ ahead: false });
    await scratch.pool.query(`
      insert into organizations (id, slug, name) values
        ('00000000-0000-7000-8000-000000000001', 'live', 'Live'),
        ('00000000-0000-7000-8000-000000000002', 'removed', 'Removed');
      insert into sso_providers (id, organization_id, provider_id, issuer, domain, oidc_config, created_at, updated_at) values
        ('00000000-0000-7000-8000-000000000003', '00000000-0000-7000-8000-000000000001', 'live', 'https://idp.example', 'live.example.com', '{"pkce":true}', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'),
        ('00000000-0000-7000-8000-000000000004', '00000000-0000-7000-8000-000000000002', 'removed', 'https://idp.example', 'removed.example.com', '{"pkce":true}', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z');
      update sso_providers set domain = 'moved.example.com', updated_at = '2026-01-03T00:00:00Z'
        where provider_id = 'live';
      update sso_providers set deleted_at = '2026-01-04T00:00:00Z', oidc_config = null
        where provider_id = 'removed';
    `);
    const before = await rows();
    expect(before.map((row) => row.revision)).toEqual([2, 2]);
    expect(before[0]).not.toHaveProperty("kind");

    expect(await runMigrations(scratch.db)).toEqual({ ahead: false });

    // The same tuples: nothing wrote to a row, so no trigger saw one, and a session
    // naming a revision still names the current one.
    expect(await rows()).toEqual(
      before.map((row) => ({ ...row, kind: "oidc" })),
    );
    expect(await scratch.db.$count(sql`drizzle.__drizzle_migrations`)).toBe(
      committedCount,
    );
  } finally {
    log.mockRestore();
    await scratch.close();
    await connection.pool.query(`drop database ${name} with (force)`);
    await rm(folder, { recursive: true, force: true });
  }
});
