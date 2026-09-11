import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";

/** PostgreSQL objects omitted from Drizzle's generated snapshot. No live data. */
export async function migrationCatalog(db: Database) {
  const functions = await db.execute<{
    name: string;
    definition: string;
    security_definer: boolean;
    settings: string[] | null;
    public_execute: boolean;
  }>(sql`
    select p.oid::regprocedure::text as name, pg_get_functiondef(p.oid) as definition,
      p.prosecdef as security_definer, p.proconfig as settings,
      exists(select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_execute
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' order by name
  `);
  const triggers = await db.execute(sql`
    select c.relname as table_name, t.tgname as name, t.tgenabled as enabled,
      pg_get_triggerdef(t.oid) as definition
    from pg_trigger t join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and not t.tgisinternal order by c.relname, t.tgname
  `);
  const policies = await db.execute(sql`
    select tablename, policyname, permissive, roles, cmd, qual, with_check
    from pg_policies where schemaname = 'public' order by tablename, policyname
  `);
  const rls = await db.execute(sql`
    select relname as table_name, relrowsecurity as enabled, relforcerowsecurity as forced
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' order by relname
  `);
  const deferred = await db.execute(sql`
    select conrelid::regclass::text as table_name, conname as name,
      condeferrable as deferrable, condeferred as initially_deferred
    from pg_constraint where connamespace = 'public'::regnamespace and contype = 'f'
    order by table_name, name
  `);
  return {
    functions: functions.rows.map(({ definition, ...attributes }) => ({
      ...attributes,
      definitionHash: createHash("sha256")
        .update(
          definition
            .replace(/--[^\n]*/g, "")
            .replace(/\s+/g, " ")
            .trim(),
        )
        .digest("hex"),
    })),
    triggers: triggers.rows,
    policies: policies.rows,
    rls: rls.rows,
    deferred: deferred.rows,
  };
}
