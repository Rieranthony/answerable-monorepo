import { eq } from "drizzle-orm";

import type { Database, Executor } from "../client.ts";
import { oauthClients, organizations } from "../schema/index.ts";

export class OAuthClientNotFoundError extends Error {
  constructor(clientId: string) {
    super(`OAuth client not found: ${clientId}`);
    this.name = "OAuthClientNotFoundError";
  }
}

export async function assignClientOrganization(
  db: Database,
  input: { clientId: string; organizationId: string },
) {
  const [client] = await db
    .update(oauthClients)
    .set({ organizationId: input.organizationId })
    .where(eq(oauthClients.clientId, input.clientId))
    .returning();

  if (!client) throw new OAuthClientNotFoundError(input.clientId);

  return client;
}

export async function findClientPrincipal(
  executor: Executor,
  clientId: string,
) {
  const [client] = await executor
    .select({
      clientId: oauthClients.clientId,
      disabled: oauthClients.disabled,
      clientCredentialsScopes: oauthClients.clientCredentialsScopes,
      organizationId: oauthClients.organizationId,
      organization: {
        id: organizations.id,
        slug: organizations.slug,
        status: organizations.status,
      },
    })
    .from(oauthClients)
    .leftJoin(organizations, eq(organizations.id, oauthClients.organizationId))
    .where(eq(oauthClients.clientId, clientId))
    .limit(1);
  return client ?? null;
}

export type ClientPrincipalRow = NonNullable<
  Awaited<ReturnType<typeof findClientPrincipal>>
>;
