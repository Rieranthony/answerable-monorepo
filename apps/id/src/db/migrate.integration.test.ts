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

import { testEnvironment } from "../__tests__/support.ts";
import { createDatabase } from "./client.ts";
import { runMigrations } from "./migrate.ts";

const connection = createDatabase(testEnvironment());
const committed = fileURLToPath(new URL("../../drizzle", import.meta.url));
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
  ["every migration", 2],
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
      expect(applied).toHaveLength(2);
      expect(await runMigrations(connection.db, folder)).toEqual({
        ahead: true,
      });
      expect(await receipts()).toEqual(applied);
      expect(log.mock.calls).toEqual([
        [
          `The database has applied 2 migrations and this image carries ${2 - missing}; applying nothing.`,
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
