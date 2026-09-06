import { expect, test } from "bun:test";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";

import * as schema from "./schema/index.ts";

test("the schema matches the committed migrations", async () => {
  const folder = new URL("../../drizzle/", import.meta.url);
  const journal: { entries: { tag: string }[] } = await Bun.file(
    new URL("meta/_journal.json", folder),
  ).json();

  expect(journal.entries.length).toBeGreaterThan(0);
  for (const entry of journal.entries) {
    expect(await Bun.file(new URL(`${entry.tag}.sql`, folder)).exists()).toBe(
      true,
    );
  }

  const tag = journal.entries.at(-1)!.tag;
  // Drizzle names snapshots by the migration number, without the SQL name.
  const number = tag.split("_")[0];
  const previous = await Bun.file(
    new URL(`meta/${number}_snapshot.json`, folder),
  ).json();
  const current = generateDrizzleJson(schema, previous.id);

  expect(
    await generateMigration(previous, current),
    "Schema drifted from the committed migrations; run `bun run db:generate`",
  ).toEqual([]);
});
