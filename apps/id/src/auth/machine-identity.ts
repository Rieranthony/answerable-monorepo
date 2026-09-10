import type { OAuthProviderExtension } from "@better-auth/oauth-provider";
import { getCurrentAdapter, type DBAdapter } from "better-auth";
import { APIError } from "better-auth/api";
import { z } from "zod";
import { setDatabaseScope } from "../db/isolation.ts";
import { lockResource } from "../db/resource-lock.ts";
import { authTransaction } from "./database-adapter.ts";
import { lockOrganization } from "../db/organization-lock.ts";
import { organizations, oauthClients } from "../db/schema/index.ts";
import { eq } from "drizzle-orm";
import { lockClient } from "../db/client-lock.ts";

export const machineIdentitySchema = z.object({
  client_instance: z.uuid(),
  organization_id: z.uuid(),
  organization_authorization_version: z.number().int().positive(),
  authorization_version: z.number().int().positive(),
  subject_type: z.literal("client"),
});

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
  if (!authenticated.success)
    throw new APIError("UNAUTHORIZED", { error: "invalid_client" });
  const tx = authTransaction(adapter);
  const organization = await lockOrganization(
    tx,
    authenticated.data.organizationId,
    "share",
  );
  const current = clientSchema.safeParse(
    await lockClient(tx, client.clientId, "share"),
  );
  if (
    !current.success ||
    organization?.status !== "active" ||
    current.data.id !== authenticated.data.id ||
    current.data.organizationId !== authenticated.data.organizationId ||
    current.data.authorizationVersion !==
      authenticated.data.authorizationVersion
  )
    throw new APIError("UNAUTHORIZED", { error: "invalid_client" });
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
export function machineIdentity(): OAuthProviderExtension {
  return {
    claims: {
      accessToken: async ({ ctx, client, user, grantType }) => {
        const reject = () =>
          new APIError("UNAUTHORIZED", { error: "invalid_client" });
        if (user || grantType !== "client_credentials") throw reject();
        const authenticated = clientSchema.safeParse(client);
        if (!authenticated.success) throw reject();
        const adapter = await getCurrentAdapter(ctx.context.adapter);
        const tx = authTransaction(adapter);
        // The authenticated adapter transaction already holds the organisation lock.
        const [organization] = await tx
          .select({
            status: organizations.status,
            authorizationVersion: organizations.authorizationVersion,
          })
          .from(organizations)
          .where(eq(organizations.id, authenticated.data.organizationId));
        const [currentRow] = await tx
          .select({
            id: oauthClients.id,
            organizationId: oauthClients.organizationId,
            authorizationVersion: oauthClients.authorizationVersion,
            disabled: oauthClients.disabled,
            deletedAt: oauthClients.deletedAt,
          })
          .from(oauthClients)
          .where(eq(oauthClients.clientId, client.clientId));
        const current = clientSchema.safeParse(currentRow);
        if (
          !current.success ||
          current.data.id !== authenticated.data.id ||
          current.data.organizationId !== authenticated.data.organizationId ||
          current.data.authorizationVersion !==
            authenticated.data.authorizationVersion
        )
          throw reject();
        if (
          organization?.status !== "active" ||
          !Number.isSafeInteger(organization.authorizationVersion) ||
          organization.authorizationVersion < 1
        )
          throw reject();
        return {
          client_instance: current.data.id,
          organization_id: current.data.organizationId,
          organization_authorization_version: organization.authorizationVersion,
          authorization_version: current.data.authorizationVersion,
          subject_type: "client",
        };
      },
    },
  };
}
