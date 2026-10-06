import { lockOrganization } from "../db/organization-lock.ts";
import { lockClient } from "../db/client-lock.ts";
import { lockResource } from "../db/resource-lock.ts";
import { rethrowGrantError } from "./grant-error.ts";
import { and, eq, sql } from "drizzle-orm";
import {
  grantContexts,
  users,
  oauthClients,
  oauthResources,
} from "../db/schema/index.ts";
import { authTransaction } from "./database-adapter.ts";
import type { Executor } from "../db/client.ts";

/** Caller must hold a transaction through admission and persistence. */
export async function lockResourceGrantTargets(
  tx: Executor,
  target: {
    userId: string;
    organizationId: string;
    clientId: string;
    resource: string | null;
  },
) {
  await tx
    .select({ id: users.id })
    .from(users)
    .where(and(sql`${users.deletedAt} is null`, eq(users.id, target.userId)))
    .for("share")
    .catch(rethrowGrantError);
  await lockOrganization(tx, target.organizationId, "share").catch(
    rethrowGrantError,
  );
  await lockClient(tx, target.clientId, "share").catch(rethrowGrantError);
  if (target.resource !== null)
    await lockResource(tx, target.resource, "share").catch(rethrowGrantError);
}

/** Hold user → organisation → client → resource → family.
 * These are the same rows locked by tenant and target configuration writers.
 * Identity fields are immutable; policy is re-read after all locks are acquired.
 */
export async function lockResourceGrantPolicy(
  adapter: object,
  input: { id: string; clientId: string },
) {
  const tx = authTransaction(adapter);
  const [target] = await tx
    .select({
      userId: grantContexts.userId,
      organizationId: grantContexts.organizationId,
      clientId: oauthClients.clientId,
      resource: oauthResources.identifier,
    })
    .from(grantContexts)
    .innerJoin(
      oauthClients,
      eq(oauthClients.id, grantContexts.clientInstanceId),
    )
    .leftJoin(
      oauthResources,
      eq(oauthResources.id, grantContexts.resourceInstanceId),
    )
    .where(
      and(
        sql`${oauthResources.deletedAt} is null`,
        sql`${oauthClients.deletedAt} is null`,
        eq(grantContexts.id, input.id),
        eq(oauthClients.clientId, input.clientId),
      ),
    )
    .catch(rethrowGrantError);
  if (!target) return;
  await lockResourceGrantTargets(tx, target);
}
