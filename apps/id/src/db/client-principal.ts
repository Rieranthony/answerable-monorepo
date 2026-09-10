import { withDatabaseScope } from "./isolation.ts";
import { findMachineCapability } from "./queries/capabilities.ts";
import { and, eq, sql } from "drizzle-orm";
import type { Executor } from "./client.ts";
import {
  oauthClients,
  oauthClientResources,
  oauthResources,
  organizations,
  systemBindings,
} from "./schema/index.ts";

/** Internal principal-resolution lookup; callers authenticate and validate current authority.
 * It cannot require an administrative context before that authority is established.
 */
export async function findClientPrincipal(
  executor: Executor,
  clientId: string,
  resource: string,
) {
  return executor.transaction(async (tx) => {
    const [identity] = await tx
      .select({
        id: oauthClients.id,
        organizationId: oauthClients.organizationId,
      })
      .from(oauthClients)
      .where(eq(oauthClients.clientId, clientId));
    if (!identity) return null;
    // Follow the protocol lock order and re-read authority after any wait.
    if (identity.organizationId)
      await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, identity.organizationId))
        .for("share");
    await tx
      .select({ id: oauthClients.id })
      .from(oauthClients)
      .where(eq(oauthClients.id, identity.id))
      .for("share");
    await tx
      .select({ id: oauthResources.id })
      .from(oauthResources)
      .where(eq(oauthResources.identifier, resource))
      .for("share");
    const [client] = await tx
      .select({
        id: oauthClients.id,
        authorizationVersion: oauthClients.authorizationVersion,
        clientId: oauthClients.clientId,
        disabled: oauthClients.disabled,
        clientCredentialsScopes: oauthClients.clientCredentialsScopes,
        resourceScopes: oauthResources.allowedScopes,
        organizationId: oauthClients.organizationId,
        isPlatform: sql<boolean>`exists(select 1 from ${systemBindings} where ${systemBindings.organizationId} = ${oauthClients.organizationId})`,
        organization: {
          id: organizations.id,
          slug: organizations.slug,
          status: organizations.status,
          authorizationVersion: organizations.authorizationVersion,
        },
      })
      .from(oauthClients)
      .leftJoin(
        organizations,
        eq(organizations.id, oauthClients.organizationId),
      )
      .innerJoin(
        oauthClientResources,
        eq(oauthClientResources.clientId, oauthClients.clientId),
      )
      .innerJoin(
        oauthResources,
        eq(oauthResources.identifier, oauthClientResources.resourceId),
      )
      .where(
        and(
          eq(oauthClients.id, identity.id),
          eq(oauthResources.identifier, resource),
          eq(oauthResources.disabled, false),
        ),
      )
      .limit(1);
    if (!client?.organizationId) return client ?? null;
    const ceiling = await withDatabaseScope(
      tx,
      { kind: "tenant", access: "read", organizationId: client.organizationId },
      (tx) =>
        findMachineCapability(tx, {
          organizationId: client.organizationId!,
          clientId,
          resource,
        }),
    );
    return {
      ...client,
      clientCredentialsScopes: (client.clientCredentialsScopes ?? []).filter(
        (scope) => ceiling?.capability.scopes.includes(scope),
      ),
    };
  });
}

export type ClientPrincipalRow = NonNullable<
  Awaited<ReturnType<typeof findClientPrincipal>>
>;
