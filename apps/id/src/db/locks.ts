import { and, eq, isNull } from "drizzle-orm";
import type { Executor } from "./client.ts";
import {
  oauthClients,
  oauthResources,
  organizations,
  users,
} from "./schema/index.ts";

/** Row locks for authority establishment and protocol transactions. Callers
 * establish current authority before exposing data or changing state;
 * administrative services use the context-guarded queries instead.
 */
type LockMode = "update" | "share";

export async function lockOrganization(
  executor: Executor,
  id: string,
  mode: LockMode = "update",
) {
  const [row] = await executor
    .select()
    .from(organizations)
    .where(and(isNull(organizations.deletedAt), eq(organizations.id, id)))
    .for(mode);
  return row ?? null;
}

export async function lockClient(
  executor: Executor,
  clientId: string,
  mode: LockMode = "update",
) {
  const [row] = await executor
    .select()
    .from(oauthClients)
    .where(
      and(isNull(oauthClients.deletedAt), eq(oauthClients.clientId, clientId)),
    )
    .for(mode);
  return row ?? null;
}

export async function lockResource(
  executor: Executor,
  identifier: string,
  mode: LockMode = "update",
) {
  const [row] = await executor
    .select()
    .from(oauthResources)
    .where(
      and(
        isNull(oauthResources.deletedAt),
        eq(oauthResources.identifier, identifier),
      ),
    )
    .for(mode);
  return row ?? null;
}

export async function lockUser(
  executor: Executor,
  id: string,
  mode: LockMode = "update",
) {
  const [row] = await executor
    .select()
    .from(users)
    .where(and(isNull(users.deletedAt), eq(users.id, id)))
    .for(mode);
  return row ?? null;
}
