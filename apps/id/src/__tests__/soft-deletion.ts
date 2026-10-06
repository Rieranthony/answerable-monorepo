import { sql, type SQL } from "drizzle-orm";
import type { Database } from "../db/client.ts";

// Soft deletion written directly, children first as the live foreign keys require.
// Unlike erasure, sessions, codes and token rows stay, so a test sees what a
// consumer does with a deleted parent's leftovers.

async function run(db: Database, statements: SQL[]) {
  for (const statement of statements) await db.execute(statement);
}

/** The user, its memberships with their assignments, account bindings and consents. */
export function softDeleteUser(db: Database, userId: string) {
  const memberIds = sql`(select id from members where user_id = ${userId})`;
  return run(db, [
    sql`update entitlements set deleted_at = now(), status = 'disabled' where deleted_at is null and member_id in ${memberIds}`,
    sql`update group_members set deleted_at = now() where deleted_at is null and member_id in ${memberIds}`,
    sql`update members set deleted_at = now(), status = 'revoked', revoked_at = coalesce(revoked_at, now()) where deleted_at is null and user_id = ${userId}`,
    sql`update accounts set deleted_at = now(), access_token = null, refresh_token = null, id_token = null, password = null where deleted_at is null and user_id = ${userId}`,
    sql`update oauth_consents set deleted_at = now() where deleted_at is null and user_id = ${userId}`,
    sql`update users set deleted_at = now(), status = 'disabled', disabled_at = coalesce(disabled_at, now()) where id = ${userId}`,
  ]);
}

/** The client, the entitlements, capabilities, resource links and consents naming it. */
export function softDeleteClient(db: Database, clientId: string) {
  return run(db, [
    sql`update entitlements set deleted_at = now(), status = 'disabled' where deleted_at is null and client_id = ${clientId}`,
    sql`update organization_capabilities set deleted_at = now(), status = 'disabled' where deleted_at is null and client_id = ${clientId}`,
    sql`update oauth_client_resources set deleted_at = now() where deleted_at is null and client_id = ${clientId}`,
    sql`update oauth_consents set deleted_at = now() where deleted_at is null and client_id = ${clientId}`,
    sql`update oauth_clients set deleted_at = now(), disabled = true, client_secret = null where client_id = ${clientId}`,
  ]);
}
