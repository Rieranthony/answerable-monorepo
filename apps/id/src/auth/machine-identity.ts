import type { OAuthProviderExtension } from "@better-auth/oauth-provider";
import { getCurrentAdapter, type DBAdapter } from "better-auth";
import { APIError } from "better-auth/api";
import { z } from "zod";
import { setDatabaseScope } from "../db/isolation.ts";
import { lockResource, lockOrganization, lockClient } from "../db/locks.ts";
import { authTransaction } from "./database-adapter.ts";
import { organizations } from "../db/schema/index.ts";
import { eq } from "drizzle-orm";

export const machineIdentitySchema = z.object({
  client_instance: z.uuid(),
  organization_id: z.uuid(),
  organization_authorization_version: z.number().int().positive(),
  authorization_version: z.number().int().positive(),
  subject_type: z.literal("client"),
});

const invalidClient = () =>
  new APIError("UNAUTHORIZED", { error: "invalid_client" });
const clientSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  authorizationVersion: z.number().int().positive(),
  disabled: z.literal(false),
  deletedAt: z.null().optional(),
});

/** Lock before the provider reads policy; refresh configuration after authentication. */
export async function prepareMachineGrant<T extends { clientId: string }>(
  adapter: Pick<DBAdapter, "findOne">,
  client: T,
  resource: string,
): Promise<T & { organizationId: string }> {
  const authenticated = clientSchema.safeParse(client);
  if (!authenticated.success) throw invalidClient();
  const tx = authTransaction(adapter);
  const organization = await lockOrganization(
    tx,
    authenticated.data.organizationId,
    "share",
  );
  const current = clientSchema.safeParse(
    await lockClient(tx, client.clientId, "share"),
  );
  // One row per client_id, whose id and organisation never change
  // (protect_oauth_client_identity); a credential change or a disable since
  // authentication bumps the authorisation version.
  if (
    !current.success ||
    organization?.status !== "active" ||
    current.data.authorizationVersion !==
      authenticated.data.authorizationVersion
  )
    throw invalidClient();
  const target = await lockResource(tx, resource, "share");
  if (
    target?.classification === "tenant_owned" &&
    target.organizationId !== current.data.organizationId
  )
    throw new APIError("BAD_REQUEST", { error: "invalid_target" });
  await setDatabaseScope(tx, {
    kind: "tenant",
    access: "read",
    organizationId: current.data.organizationId,
  });
  // The locked row cannot disappear; preserve the supported adapter's transforms.
  return (await adapter.findOne<T & { organizationId: string }>({
    model: "oauthClient",
    where: [{ field: "clientId", value: client.clientId }],
  }))!;
}

/** Claim inputs come from the provider's authenticated client, never metadata. */
export function machineIdentity() {
  return {
    claims: {
      accessToken: async ({ ctx, client, user, grantType }) => {
        if (user || grantType !== "client_credentials") throw invalidClient();
        // The row prepareMachineGrant returned, after locking and checking it
        // and its organisation for share in this transaction.
        const current = clientSchema.safeParse(client);
        if (!current.success) throw invalidClient();
        const adapter = await getCurrentAdapter(ctx.context.adapter);
        const [organization] = await authTransaction(adapter)
          .select({ authorizationVersion: organizations.authorizationVersion })
          .from(organizations)
          .where(eq(organizations.id, current.data.organizationId));
        return {
          client_instance: current.data.id,
          organization_id: current.data.organizationId,
          organization_authorization_version:
            organization!.authorizationVersion,
          authorization_version: current.data.authorizationVersion,
          subject_type: "client",
        };
      },
    },
  } satisfies OAuthProviderExtension;
}
