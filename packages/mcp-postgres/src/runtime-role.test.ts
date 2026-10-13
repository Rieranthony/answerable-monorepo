import { afterAll, beforeAll, expect, test } from "bun:test"
import type { Intent } from "@answerable/mcp"
import { createEvidence, type EvidenceEvent } from "./evidence"
import { createPostgresIntentStore } from "./intents"
import { migrate, migrations } from "./migrate"
import { assertRuntimeRole, configureRuntimeRole, runtimeGrants } from "./runtime-role"
import { database } from "./test/database"

// The owner, a superuser in the development Postgres, and a fresh login provisioned with this package's grants, as a server's migrate script does.
const owner = database.connect()
let login: Awaited<ReturnType<typeof database.runtimeLogin>>
beforeAll(async () => {
  await migrate(owner, [migrations])
  login = await database.runtimeLogin(runtimeGrants)
})
afterAll(async () => {
  await login.drop()
  await owner.close()
})

// A Bun.sql query runs when awaited, which expect(...).rejects does not do.
const run = async (query: PromiseLike<unknown>) => { await query }
const event = (organisation_id: string, overrides: Partial<EvidenceEvent> = {}): EvidenceEvent => ({
  organisation_id, kind: "capability.completed", actor_type: "user", actor_id: crypto.randomUUID(), outcome: "success", ...overrides,
})
function intent(now = Date.now()): Intent {
  return {
    intent_id: Bun.randomUUIDv7(), organisation_id: crypto.randomUUID(),
    principal: { user_id: crypto.randomUUID(), membership_id: crypto.randomUUID(), client_id: "claude-code" },
    capability_identity: "e2e/records.delete", capability_version: "2026-09-29", input: { id: "5b0e" }, targets: [],
    preview: { summary: "Delete record 5b0e", changes: [], effects: [], warnings: [], quantities: [] }, policy_class: "controlled", commit_token_hash: "a".repeat(64), status: "prepared",
    created_at: new Date(now).toISOString(), expires_at: new Date(now + 600_000).toISOString(),
  }
}
// Every privilege on every table of public that `role` holds, as "table: PRIVILEGE, …".
async function reach(role: string) {
  const rows = await owner`select c.relname as table, string_agg(p.privilege, ', ' order by p.privilege) as privileges
    from pg_class c join pg_namespace n on n.oid = c.relnamespace,
      unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p (privilege)
    where n.nspname = 'public' and c.relkind = 'r' and has_table_privilege(${role}::name, c.oid, p.privilege)
    group by c.relname order by c.relname`
  return Object.fromEntries(rows.map((row: { table: string; privileges: string }) => [row.table, row.privileges]))
}
// The access control lists configureRuntimeRole writes: the tables', the schema's, the database's and the default privileges.
const acls = () => owner`select 'table ' || c.relname as object, c.relacl::text as acl from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'
  union all select 'schema public', nspacl::text from pg_namespace where nspname = 'public'
  union all select 'database', datacl::text from pg_database where datname = current_database()
  union all select 'default ' || defaclobjtype::text || ' ' || defaclnamespace::regnamespace::text, defaclacl::text from pg_default_acl
  order by 1, 2`

test("the role appends and reads evidence, erases a payload's body, and moves and sweeps intents", async () => {
  const evidence = createEvidence(login.db)
  const organisation = crypto.randomUUID()
  const { payload_ref } = await evidence.record(event(organisation, { kind: "intent.prepared", payload: { summary: "Delete" } }))
  await evidence.record(event(organisation))
  await evidence.erase(payload_ref!)
  expect(await evidence.verify(organisation)).toEqual({ ok: true, length: 2 })
  // The first insert sweeps, which deletes.
  const store = createPostgresIntentStore(login.db, evidence)
  const prepared = intent()
  await store.insert(prepared)
  expect(await store.get(prepared.intent_id)).toEqual(prepared)
  expect(await store.transition(prepared.intent_id, "prepared", "stale")).toBe(true)
  expect(await reach(login.role)).toEqual({ evidence_events: "INSERT, SELECT", evidence_payloads: "INSERT, SELECT, UPDATE", intents: "DELETE, INSERT, SELECT, UPDATE" })
})

test("the role cannot rewrite the evidence, drop or disable its triggers, create a table or a temporary table, or read schema_migrations", async () => {
  const organisation = crypto.randomUUID()
  const { payload_ref } = await createEvidence(login.db).record(event(organisation, { kind: "intent.prepared", payload: { summary: "Delete" } }))
  const db = login.db
  await expect(run(db`update evidence_events set outcome = 'failure' where organisation_id = ${organisation}`)).rejects.toThrow("permission denied for table evidence_events")
  await expect(run(db`delete from evidence_events where organisation_id = ${organisation}`)).rejects.toThrow("permission denied for table evidence_events")
  await expect(run(db`truncate evidence_events`)).rejects.toThrow("permission denied for table evidence_events")
  await expect(run(db`drop trigger evidence_append_only on evidence_events`)).rejects.toThrow("must be owner of relation evidence_events")
  await expect(run(db`alter table evidence_events disable trigger evidence_append_only`)).rejects.toThrow("must be owner of table evidence_events")
  await expect(run(db`alter table evidence_payloads disable trigger evidence_payload_erase_only`)).rejects.toThrow("must be owner of table evidence_payloads")
  // The role may update a payload, so the trigger is what refuses anything but an erasure.
  await expect(run(db`update evidence_payloads set body = '{"summary": "Keep"}' where id = ${payload_ref}`)).rejects.toThrow("evidence_payloads only erases a body: UPDATE is refused")
  await expect(run(db`delete from evidence_payloads where id = ${payload_ref}`)).rejects.toThrow("permission denied for table evidence_payloads")
  await expect(run(db`create table runtime_scratch (id int)`)).rejects.toThrow("permission denied for schema public")
  await expect(run(db`create temporary table runtime_scratch (id int)`)).rejects.toThrow("permission denied to create temporary tables")
  await expect(run(db`select name from schema_migrations`)).rejects.toThrow("permission denied for table schema_migrations")
  expect(await createEvidence(owner).verify(organisation)).toEqual({ ok: true, length: 1 })
})

test("a repeated run changes nothing, and a run puts back a privilege granted by hand", async () => {
  const before = await acls()
  await configureRuntimeRole(owner, login.role, runtimeGrants)
  expect(await acls()).toEqual(before)
  await owner.unsafe(`grant truncate, trigger on evidence_events to ${login.role}; grant create on schema public to ${login.role}`)
  await configureRuntimeRole(owner, login.role, runtimeGrants)
  expect(await acls()).toEqual(before)
})

test("a table a later migration adds is out of the role's reach until a grant names it, whatever default privileges said", async () => {
  const table = `scratch_${crypto.randomUUID().replaceAll("-", "")}`
  await owner.unsafe(`alter default privileges grant select on tables to ${login.role}; alter default privileges in schema public grant insert on tables to ${login.role}`)
  try {
    await configureRuntimeRole(owner, login.role, runtimeGrants)
    await owner.unsafe(`create table ${table} (id int)`)
    expect((await reach(login.role))[table]).toBeUndefined()
    await configureRuntimeRole(owner, login.role, [...runtimeGrants, { table, privileges: ["select"] }])
    expect((await reach(login.role))[table]).toBe("SELECT")
  } finally {
    await owner.unsafe(`drop table if exists ${table}`)
  }
})

test("a role is created without login when it does not exist, and refused when it is privileged, a member of a role or an owner", async () => {
  const role = `runtime_${crypto.randomUUID().replaceAll("-", "")}`
  const table = `owned_${crypto.randomUUID().replaceAll("-", "")}`
  try {
    await configureRuntimeRole(owner, role, runtimeGrants)
    expect<unknown>(await owner`select rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolreplication, rolbypassrls from pg_roles where rolname = ${role}`).toEqual([{
      rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolinherit: false, rolreplication: false, rolbypassrls: false,
    }])
    await owner.unsafe(`alter role ${role} createdb bypassrls`)
    await expect(configureRuntimeRole(owner, role, runtimeGrants)).rejects.toThrow(`Refusing to provision ${role} as a runtime role: has CREATEDB; has BYPASSRLS`)
    await owner.unsafe(`alter role ${role} nocreatedb nobypassrls; grant pg_read_all_data to ${role}`)
    await expect(configureRuntimeRole(owner, role, runtimeGrants)).rejects.toThrow(`Refusing to provision ${role} as a runtime role: is a member of pg_read_all_data`)
    await owner.unsafe(`revoke pg_read_all_data from ${role}; create table ${table} (id int); alter table ${table} owner to ${role}`)
    await expect(configureRuntimeRole(owner, role, runtimeGrants)).rejects.toThrow(`Refusing to provision ${role} as a runtime role: owns ${table} in schema public`)
  } finally {
    await owner.unsafe(`drop table if exists ${table}; drop owned by ${role}; drop role ${role}`)
  }
})

test("a role name that is also a keyword stays a name", async () => {
  try {
    await configureRuntimeRole(owner, "user", [{ table: "intents", privileges: ["select"] }])
    expect<unknown>(await owner`select has_table_privilege('user', 'public.intents', 'SELECT') as select, has_table_privilege('user', 'public.intents', 'INSERT') as insert`).toEqual([{ select: true, insert: false }])
  } finally {
    await owner.unsafe(`drop owned by "user"; drop role "user"`)
  }
})

test("a role name, a table name or a privilege that is not plainly one is refused before anything runs", async () => {
  await expect(configureRuntimeRole(owner, "Runtime; drop table intents", runtimeGrants)).rejects.toThrow('Invalid runtime role name "Runtime; drop table intents"')
  await expect(configureRuntimeRole(owner, login.role, [{ table: "intents; drop table intents", privileges: ["select"] }])).rejects.toThrow('Invalid table name "intents; drop table intents"')
  // @ts-expect-error a privilege the type does not allow
  await expect(configureRuntimeRole(owner, login.role, [{ table: "intents", privileges: ["truncate"] }])).rejects.toThrow('Invalid privilege "truncate" on intents')
})

test("assertRuntimeRole accepts the provisioned login and refuses the owner, naming what makes it unsafe", async () => {
  await assertRuntimeRole(login.db)
  const error = await assertRuntimeRole(owner).then(() => undefined, (error: Error) => error.message)
  const tables = "evidence_events, evidence_payloads, intents, schema_migrations"
  expect(error).toBe(`Database role answerable is not a restricted runtime role: ${[
    "has SUPERUSER", "has CREATEDB", "has CREATEROLE", "has REPLICATION", "has BYPASSRLS",
    "owns evidence_append_only(), evidence_chain(), evidence_events, evidence_field(), evidence_payload_erase_only(), evidence_payloads, intents, schema_migrations in schema public",
    "owns schema public", "owns database answerable_mcp_postgres_test", "holds CREATE on schema public", "holds TEMP on database answerable_mcp_postgres_test",
    "holds UPDATE on evidence_events, schema_migrations", "holds DELETE on evidence_events, evidence_payloads, schema_migrations", "holds INSERT on schema_migrations",
    `holds TRUNCATE on ${tables}`, `holds TRIGGER on ${tables}`,
  ].join("; ")}. Serve as the runtime login that the migration provisions, never as the owner`)
})

test("assertRuntimeRole names each attribute, membership, ownership and privilege that makes a login unsafe", async () => {
  const refusal = (problem: string) => `Database role ${login.role} is not a restricted runtime role: ${problem}. Serve as the runtime login that the migration provisions, never as the owner`
  for (const attribute of ["SUPERUSER", "CREATEDB", "CREATEROLE", "REPLICATION", "BYPASSRLS"]) {
    await owner.unsafe(`alter role ${login.role} ${attribute}`)
    try {
      await expect(assertRuntimeRole(login.db)).rejects.toThrow(attribute === "SUPERUSER" ? `has SUPERUSER` : refusal(`has ${attribute}`))
    } finally {
      await owner.unsafe(`alter role ${login.role} no${attribute}`)
    }
  }
  await owner.unsafe(`grant pg_write_all_data to ${login.role}`)
  await expect(assertRuntimeRole(login.db)).rejects.toThrow(refusal("is a member of pg_write_all_data"))
  await owner.unsafe(`revoke pg_write_all_data from ${login.role}`)
  const table = `owned_${crypto.randomUUID().replaceAll("-", "")}`
  await owner.unsafe(`create table ${table} (id int); alter table ${table} owner to ${login.role}`)
  try {
    await expect(assertRuntimeRole(login.db)).rejects.toThrow(refusal(`owns ${table} in schema public; holds TRUNCATE on ${table}; holds TRIGGER on ${table}`))
  } finally {
    await owner.unsafe(`drop table ${table}`)
  }
  await owner.unsafe(`grant update, delete, truncate on evidence_events to ${login.role}; grant delete on evidence_payloads to ${login.role}`)
  await owner.unsafe(`grant insert on schema_migrations to ${login.role}; grant create on schema public to ${login.role}; grant temporary on database answerable_mcp_postgres_test to ${login.role}`)
  try {
    await expect(assertRuntimeRole(login.db)).rejects.toThrow(refusal([
      "holds CREATE on schema public", "holds TEMP on database answerable_mcp_postgres_test", "holds UPDATE on evidence_events",
      "holds DELETE on evidence_events, evidence_payloads", "holds INSERT on schema_migrations", "holds TRUNCATE on evidence_events",
    ].join("; ")))
  } finally {
    await configureRuntimeRole(owner, login.role, runtimeGrants)
  }
  await assertRuntimeRole(login.db)
})
