import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client, Pool } from "pg"
import { ensureLocalMcpDatabases } from "./local"
import { migrateMcp, migrateMcps, withoutSchemaCreation, type McpMigration } from "./migrate-mcp"
import { sharedMcps } from "./names"
import { provisionMcps, sqlOf } from "./provision"
import { as, clientOf, clusterUrl, fixtureFolder, forget, mcpsUrl, testLogin } from "./test/mcps"

const admin = new Pool({ connectionString: mcpsUrl, max: 1 })
const serving = sharedMcps.logins.toolbox
let migrator: Client
const a: McpMigration = { name: "mpgfixa", folder: fixtureFolder("mpgfixa"), serving }
const b: McpMigration = { name: "mpgfixb", folder: fixtureFolder("mpgfixb"), serving }
const provision = () => provisionMcps(sqlOf(admin), { mcps: [{ name: "mpgfixa" }, { name: "mpgfixb" }], logins: sharedMcps.logins })
beforeAll(async () => {
  await ensureLocalMcpDatabases(clusterUrl)
  migrator = await clientOf(as(sharedMcps.logins.migrator))
})
// Each test starts from freshly provisioned, empty schemas, as the migration Job finds a new MCP.
beforeEach(async () => {
  await forget(admin, "mpgfixa", "mpgfixb")
  await provision()
})
afterAll(async () => {
  await migrator.end()
  await forget(admin, "mpgfixa", "mpgfixb")
  await admin.end()
})

const rows = async (text: string, values?: unknown[]) => (await admin.query(text, values)).rows
const receipts = () => rows("select hash, created_at::text from mpgfixa.__drizzle_migrations order by id")
// The schema's relations with their owner and privileges, as the catalogue lists them.
const relations = () => rows("select relname, relkind, pg_get_userbyid(relowner) as owner, relacl::text as acl from pg_class where relnamespace = 'mpgfixa'::regnamespace order by 1")
const schemaAcl = "{answerable_mcps_migrator=UC/answerable_mcps_migrator,answerable_mcps_toolbox=U/answerable_mcps_migrator}"
// Each privilege `role` holds on each table and sequence of the schema, as "relation: PRIVILEGE, …".
async function reach(role: string) {
  const held = await rows(`select c.relname as relation, string_agg(p.privilege, ', ' order by p.privilege) as privileges
    from pg_class c, unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p (privilege)
    where c.relnamespace = 'mpgfixa'::regnamespace and c.relkind = 'r' and has_table_privilege($1::name, c.oid, p.privilege) group by 1
    union all select c.relname, 'USAGE' from pg_class c where c.relnamespace = 'mpgfixa'::regnamespace and case when c.relkind = 'S' then has_sequence_privilege($1::name, c.oid, 'USAGE') end
    order by 1`, [role])
  return Object.fromEntries(held.map(row => [row.relation, row.privileges]))
}
// A copy of fixture a's folder with a second migration, `0001_next.sql`, holding `text`; removed after `use`.
async function withNext(text: string, use: (folder: string) => Promise<void>) {
  const folder = await mkdtemp(join(tmpdir(), "mcp-postgres-mcp-migrations-"))
  try {
    await cp(a.folder, folder, { recursive: true })
    await writeFile(join(folder, "0001_next.sql"), text)
    const journal = JSON.parse(await readFile(join(folder, "meta/_journal.json"), "utf8"))
    journal.entries.push({ ...journal.entries[0], idx: 1, when: journal.entries[0].when + 1, tag: "0001_next" })
    await writeFile(join(folder, "meta/_journal.json"), JSON.stringify(journal))
    await use(folder)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}

test("the migrator migrates the schema with drizzle's migrator, the journal in it, and owns every table, taking no role", async () => {
  await migrateMcp({ ...a, client: migrator })
  expect((await relations()).filter(row => row.relkind === "r").map(({ relname, owner }) => ({ relname, owner })))
    .toEqual(["__drizzle_migrations", "notes", "projects"].map(relname => ({ relname, owner: "answerable_mcps_migrator" })))
  const journal = JSON.parse(await readFile(join(a.folder, "meta/_journal.json"), "utf8"))
  const text = await readFile(join(a.folder, "0000_initial.sql"), "utf8")
  expect(await receipts()).toEqual([{ hash: new Bun.CryptoHasher("sha256").update(text).digest("hex"), created_at: String(journal.entries[0].when) }])
  expect((await migrator.query("select current_user::text as role")).rows).toEqual([{ role: "answerable_mcps_migrator" }])
})

test("a second run with nothing pending changes nothing", async () => {
  await migrateMcp({ ...a, client: migrator })
  const [before, applied] = [await relations(), await receipts()]
  await migrateMcp({ ...a, client: migrator })
  expect(await relations()).toEqual(before)
  expect(await receipts()).toEqual(applied)
})

test("by default the serving login reads and writes every table and uses its sequence, and has nothing of the journal; PUBLIC has nothing", async () => {
  await migrateMcp({ ...a, client: migrator })
  expect(await reach(serving)).toEqual({ notes: "DELETE, INSERT, SELECT, UPDATE", notes_id_seq: "USAGE", projects: "DELETE, INSERT, SELECT, UPDATE" })
  expect(await rows("select count(*)::int as public from pg_class c, aclexplode(c.relacl) acl where c.relnamespace = 'mpgfixa'::regnamespace and acl.grantee = 0")).toEqual([{ public: 0 }])
})

test("narrowed grants are exact, and the default comes back when they go", async () => {
  await migrateMcp({ ...a, client: migrator, grants: [{ table: "notes", privileges: ["select", "insert"] }, { table: "projects", privileges: [] }] })
  expect(await reach(serving)).toEqual({ notes: "INSERT, SELECT", notes_id_seq: "USAGE" })
  await migrateMcp({ ...a, client: migrator })
  expect(await reach(serving)).toEqual({ notes: "DELETE, INSERT, SELECT, UPDATE", notes_id_seq: "USAGE", projects: "DELETE, INSERT, SELECT, UPDATE" })
})

test("every privilege granted on the schema and its objects outside the grants is revoked, PUBLIC's and another login's included", async () => {
  await migrateMcp({ ...a, client: migrator })
  const granted = await relations()
  const other = await testLogin(admin)
  try {
    await admin.query(`grant select on mpgfixa.notes to public; grant truncate on mpgfixa.projects to ${serving}; grant all on mpgfixa.__drizzle_migrations to ${other.name};
      grant usage, create on schema mpgfixa to ${other.name}; create function mpgfixa.answer() returns int language sql as 'select 42'; alter function mpgfixa.answer() owner to answerable_mcps_migrator`)
    await migrateMcp({ ...a, client: migrator })
    expect(await relations()).toEqual(granted)
    expect(await rows("select nspacl::text as acl from pg_namespace where nspname = 'mpgfixa'")).toEqual([{ acl: schemaAcl }])
    expect(await rows("select proacl::text as acl from pg_proc where proname = 'answer' and pronamespace = 'mpgfixa'::regnamespace")).toEqual([{ acl: "{answerable_mcps_migrator=X/answerable_mcps_migrator}" }])
  } finally {
    await other.drop()
  }
})

test("a GRANT a migration makes itself is taken back by the grants that follow it", async () => {
  await migrateMcp({ ...a, client: migrator })
  const granted = await relations()
  await withNext('GRANT SELECT ON "mpgfixa"."notes" TO PUBLIC;', folder => migrateMcp({ ...a, folder, client: migrator }))
  expect(await receipts()).toHaveLength(2)
  expect(await relations()).toEqual(granted)
})

test.each([
  ["an applied file was edited", "drizzle/0000_initial.sql", (folder: string) => writeFile(join(folder, "0000_initial.sql"), "-- edited\n", { flag: "a" })],
  ["an applied file was removed", "the file applied as migration 1", async (folder: string) => {
    await writeFile(join(folder, "meta/_journal.json"), JSON.stringify({ version: "7", dialect: "postgresql", entries: [] }))
  }],
])("migration refuses, naming the file, when %s", async (_, file, change) => {
  await migrateMcp({ ...a, client: migrator })
  const folder = await mkdtemp(join(tmpdir(), "mcp-postgres-mcp-migrations-"))
  try {
    await cp(a.folder, folder, { recursive: true })
    await change(folder)
    await expect(migrateMcp({ ...a, folder, client: migrator })).rejects.toThrow(`Refusing to migrate mpgfixa: ${file} is not the migration this database applied`)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test("a statement that fails names the MCP and the file, and leaves nothing behind", async () => {
  await migrateMcp({ ...a, client: migrator })
  const before = await relations()
  await withNext('CREATE TABLE "mpgfixa"."broken" (id int);\n--> statement-breakpoint\nCREATE TABLE "mpgfixa"."worse" (id nonsense);', async folder => {
    await expect(migrateMcp({ ...a, folder, client: migrator })).rejects.toThrow('mpgfixa: 0001_next.sql failed: type "nonsense" does not exist')
  })
  expect(await relations()).toEqual(before)
  expect(await receipts()).toHaveLength(1)
})

test("only a login that may create in the database migrates: the serving login is refused before any file, naming the MCP", async () => {
  const client = await clientOf(as(serving))
  try {
    await expect(migrateMcp({ ...a, client })).rejects.toThrow("mpgfixa: permission denied for database answerable_mcps_test")
  } finally {
    await client.end()
  }
  expect(await relations()).toEqual([])
})

test("a grant on the journal, an unknown privilege or a bad name is refused before any SQL runs", async () => {
  const unused = { query: () => { throw new Error("no SQL may run") } } as unknown as Client
  await expect(migrateMcp({ ...a, client: unused, grants: [{ table: "__drizzle_migrations", privileges: ["select"] }] })).rejects.toThrow('A grant names "__drizzle_migrations", which is not a table the serving login may be granted')
  await expect(migrateMcp({ ...a, client: unused, grants: [{ table: "notes; drop", privileges: ["select"] }] })).rejects.toThrow('A grant names "notes; drop"')
  // @ts-expect-error a privilege the type does not allow
  await expect(migrateMcp({ ...a, client: unused, grants: [{ table: "notes", privileges: ["truncate"] }] })).rejects.toThrow('Invalid privilege "truncate" on notes')
  await expect(migrateMcp({ ...a, client: unused, name: "Acme" })).rejects.toThrow('MCP name "Acme" must be')
  await expect(migrateMcp({ ...a, serving: "runtime; drop", client: unused })).rejects.toThrow('Invalid serving login name "runtime; drop"')
})

test("migrateMcps migrates each MCP in turn and stops at the first failure, naming it", async () => {
  const connected: string[] = []
  const connection = (mcp: McpMigration) => { connected.push(mcp.name); return migrator }
  await migrateMcps([a, b], connection)
  expect(connected).toEqual(["mpgfixa", "mpgfixb"])
  expect(await rows("select count(*)::int as receipts from mpgfixb.__drizzle_migrations")).toEqual([{ receipts: 1 }])
  connected.length = 0
  await expect(migrateMcps([{ ...b, folder: a.folder }, a], connection)).rejects.toThrow("Migrating MCP mpgfixb failed: Refusing to migrate mpgfixb: drizzle/0000_initial.sql is not the migration this database applied")
  expect(connected).toEqual(["mpgfixb"])
})

test("withoutSchemaCreation removes drizzle-kit's schema statement and its breakpoint wherever it is, and refuses any other CREATE SCHEMA", () => {
  const schema = 'CREATE SCHEMA "acme";\n'
  const table = 'CREATE TABLE "acme"."notes" (\n\t"id" uuid\n);\n'
  const rls = 'ALTER TABLE "acme"."notes" ENABLE ROW LEVEL SECURITY;'
  const bp = "--> statement-breakpoint\n"
  expect(withoutSchemaCreation(`${schema}${bp}${table}${bp}${rls}`, "acme")).toBe(`${table}${bp}${rls}`)
  expect(withoutSchemaCreation(`${table}${bp}${schema}`, "acme")).toBe(table)
  expect(withoutSchemaCreation(schema, "acme")).toBe("")
  expect(withoutSchemaCreation(`${table}${bp}${rls}`, "acme")).toBe(`${table}${bp}${rls}`)
  expect(() => withoutSchemaCreation(`${schema}${bp}${table}${bp}CREATE SCHEMA "beta";\n`, "acme")).toThrow("Refusing a migration that creates a schema other than by drizzle-kit's own line for acme: line 5")
  expect(() => withoutSchemaCreation(`create schema if not exists acme;\n`, "acme")).toThrow("line 1")
  expect(() => withoutSchemaCreation(schema, "Acme")).toThrow('MCP name "Acme" must be')
})
