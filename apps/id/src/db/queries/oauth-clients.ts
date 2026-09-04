import { eq } from "drizzle-orm";

import type { Database } from "../client.ts";
import { oauthClients } from "../schema/index.ts";

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
