import { expect, test } from "bun:test"
import { join } from "node:path"
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api"
import { withoutSchemaCreation } from "./migrate-mcp"
import * as fixtureA from "./test/fixtures/mpgfixa"
import * as fixtureB from "./test/fixtures/mpgfixb"
import { fixtureFolder } from "./test/mcps"

const isolation = (table: string) => `"mpgfixa"."${table}"."organisation_id" = nullif(current_setting('answerable.organisation_id', true), '')::uuid`

test("drizzle-kit gives a pgSchema table with organisationIsolation row-level security and its policy, both in the MCP's schema", async () => {
  const statements = await generateMigration(generateDrizzleJson({}), generateDrizzleJson(fixtureA))
  expect(statements).toEqual(expect.arrayContaining([
    'CREATE SCHEMA "mpgfixa";\n',
    'ALTER TABLE "mpgfixa"."notes" ENABLE ROW LEVEL SECURITY;',
    'ALTER TABLE "mpgfixa"."projects" ENABLE ROW LEVEL SECURITY;',
    ...["notes", "projects"].map(table => `CREATE POLICY "organisation_isolation" ON "mpgfixa"."${table}" AS PERMISSIVE FOR ALL TO public USING (${isolation(table)}) WITH CHECK (${isolation(table)});`),
  ]))
})

test("each fixture's committed migration is what drizzle-kit writes for its schema, without the schema line", async () => {
  for (const [name, schema] of [["mpgfixa", fixtureA], ["mpgfixb", fixtureB]] as const) {
    // drizzle-kit's own file writer joins statements with this breakpoint.
    const written = (await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))).join("--> statement-breakpoint\n")
    expect(withoutSchemaCreation(written, name)).toBe(await Bun.file(join(fixtureFolder(name), "0000_initial.sql")).text())
  }
})
