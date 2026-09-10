import { and, eq, sql } from "drizzle-orm";
import type { Executor } from "../client.ts";
import {
  organizationCapabilities,
  oauthResources,
  oauthClients,
  organizations,
} from "../schema/index.ts";
import { isEffective } from "./effective.ts";

/** Callers establish the tenant read scope; issuance holds the policy locks. */
export async function findMachineCapability(
  tx: Executor,
  input: { organizationId: string; clientId: string; resource: string },
) {
  const [row] = await tx
    .select({
      capability: organizationCapabilities,
      organization: {
        id: organizations.id,
        authorizationVersion: organizations.authorizationVersion,
      },
      client: {
        id: oauthClients.id,
        clientId: oauthClients.clientId,
        revision: oauthClients.revision,
        authorizationVersion: oauthClients.authorizationVersion,
        scopeCeiling: oauthClients.clientCredentialsScopes,
      },
      resource: {
        id: oauthResources.id,
        identifier: oauthResources.identifier,
        revision: oauthResources.revision,
        scopeCeiling: oauthResources.allowedScopes,
      },
      evaluatedAt: sql<string>`statement_timestamp()::text`,
    })
    .from(organizationCapabilities)
    .innerJoin(
      oauthResources,
      eq(oauthResources.identifier, organizationCapabilities.resource),
    )
    .innerJoin(
      oauthClients,
      eq(oauthClients.clientId, organizationCapabilities.clientId),
    )
    .innerJoin(
      organizations,
      eq(organizations.id, organizationCapabilities.organizationId),
    )
    .where(
      and(
        eq(organizationCapabilities.organizationId, input.organizationId),
        eq(organizationCapabilities.clientId, input.clientId),
        eq(organizationCapabilities.resource, input.resource),
        eq(organizationCapabilities.grantKind, "client_credentials"),
        isEffective(organizationCapabilities),
        eq(oauthResources.disabled, false),
      ),
    );
  return row ?? null;
}
