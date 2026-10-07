import {
  lockClient,
  lockOrganization,
  lockResource,
  lockUser,
} from "../db/locks.ts";
import { rethrowGrantError } from "./grant-error.ts";
import { and, eq, isNull } from "drizzle-orm";
import {
  grantContexts,
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
  await lockUser(tx, target.userId, "share").catch(rethrowGrantError);
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
        isNull(oauthResources.deletedAt),
        isNull(oauthClients.deletedAt),
        eq(grantContexts.id, input.id),
        eq(oauthClients.clientId, input.clientId),
      ),
    )
    .catch(rethrowGrantError);
  if (!target) return;
  await lockResourceGrantTargets(tx, target);
}
