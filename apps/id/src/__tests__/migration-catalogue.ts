import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type { Pool, PoolClient } from "pg";

import * as schema from "../db/schema/index.ts";
import { resetPublicSchema } from "./test-database.ts";

const migrationsFolder = fileURLToPath(
  new URL("../../drizzle", import.meta.url),
);
const breakpoint = "--> statement-breakpoint";

/** Every committed statement, in the order the migrator runs them. */
export function committedStatements(): string[] {
  return readMigrationFiles({ migrationsFolder }).flatMap(({ sql }) => sql);
}

const readJson = (path: string) =>
  JSON.parse(readFileSync(`${migrationsFolder}/${path}`, "utf8"));

/** A snapshot without its own identity: what the schema modules held at that migration. */
function schemaAt(tag: string): unknown {
  return {
    ...readJson(`meta/${tag.split("_")[0]}_snapshot.json`),
    id: null,
    prevId: null,
  };
}

/**
 * The migrations reviewed by hand, in order: `db:generate --custom` repeats the schema
 * modules' snapshot, so each is a migration that describes nothing they hold.
 */
function reviewedMigrations(): string[] {
  const { entries } = readJson("meta/_journal.json") as {
    entries: { tag: string }[];
  };
  return entries
    .filter(
      ({ tag }, index) =>
        index > 0 &&
        isDeepStrictEqual(schemaAt(tag), schemaAt(entries[index - 1]!.tag)),
    )
    .map(({ tag }) => tag);
}

/** What drizzle-kit generates from the schema modules, then every reviewed migration. */
export async function generatedStatements(): Promise<string[]> {
  const empty = generateDrizzleJson({});
  const generated = await generateMigration(
    empty,
    generateDrizzleJson(schema, empty.id),
  );
  const reviewed = reviewedMigrations().flatMap((tag) =>
    readFileSync(`${migrationsFolder}/${tag}.sql`, "utf8").split(breakpoint),
  );
  return [...generated, ...reviewed];
}

// Postgres' own description of the public schema: every line is deparsed by the server,
// so two databases that print the same lines hold the same objects.
const catalogue = `
select 'table ' || c.relname || ' rls=' || c.relrowsecurity || ' force=' || c.relforcerowsecurity
    || ' acl=' || coalesce(c.relacl::text, 'default') as line
  from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
union all
select 'column ' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
    || ' notnull=' || a.attnotnull || ' identity=' || a.attidentity::text || ' generated=' || a.attgenerated::text
    || ' default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '-')
  from pg_attribute a join pg_class c on c.oid = a.attrelid
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
union all
select 'constraint ' || conrelid::regclass || ' ' || conname || ' ' || pg_get_constraintdef(oid)
    || ' deferrable=' || condeferrable || ' deferred=' || condeferred
  from pg_constraint where connamespace = 'public'::regnamespace
union all
select 'index ' || pg_get_indexdef(i.indexrelid)
  from pg_index i join pg_class c on c.oid = i.indrelid where c.relnamespace = 'public'::regnamespace
union all
select 'policy ' || tablename || '.' || policyname || ' ' || permissive || ' ' || array_to_string(roles, ',')
    || ' ' || cmd || ' using=' || coalesce(qual, '-') || ' check=' || coalesce(with_check, '-')
  from pg_policies where schemaname = 'public'
union all
select 'function ' || pg_get_functiondef(p.oid) || ' acl=' || coalesce(p.proacl::text, 'default')
  from pg_proc p where p.pronamespace = 'public'::regnamespace
union all
select 'trigger ' || pg_get_triggerdef(t.oid) || ' enabled=' || t.tgenabled::text
  from pg_trigger t join pg_class c on c.oid = t.tgrelid
  where c.relnamespace = 'public'::regnamespace and not t.tgisinternal
order by 1`;

/** The catalogue of the database as it stands. */
async function readCatalogue(client: Pool | PoolClient): Promise<string[]> {
  const { rows } = await client.query<{ line: string }>(catalogue);
  return rows.map(({ line }) => line);
}

/**
 * Applies the statements to an empty public schema inside a transaction, reads the
 * catalogue and rolls back, so the database is left as it was.
 */
export async function buildCatalogue(
  pool: Pool,
  statements: string[],
): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await resetPublicSchema(client);
    for (const statement of statements) await client.query(statement);
    return await readCatalogue(client);
  } finally {
    await client.query("rollback");
    client.release();
  }
}
