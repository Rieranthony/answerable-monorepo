import { count, and, desc, eq, ilike, or } from "drizzle-orm";

import { beforeCursor, type PageQuery } from "../../http/pagination.ts";
import { createId } from "../../lib/id.ts";
import type { Executor } from "../client.ts";
import {
  entitlements,
  oauthClients,
  oauthClientResources,
  organizations,
} from "../schema/index.ts";

export class OAuthClientNotFoundError extends Error {
  constructor(clientId: string) {
    super(`OAuth client not found: ${clientId}`);
    this.name = "OAuthClientNotFoundError";
  }
}

export async function assignClientOrganization(
  db: Executor,
  input: { clientId: string; organizationId: string | null },
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

export type ClientInput = Omit<
  typeof oauthClients.$inferInsert,
  "id" | "createdAt" | "updatedAt"
>;
export type ClientPatch = Partial<
  Pick<
    ClientInput,
    | "name"
    | "uri"
    | "contacts"
    | "redirectUris"
    | "postLogoutRedirectUris"
    | "scopes"
    | "clientCredentialsScopes"
    | "jwks"
    | "jwksUri"
    | "skipConsent"
    | "backchannelLogoutUri"
  >
>;
export type ClientQuery = PageQuery & {
  q?: string;
  organizationId?: string;
  disabled?: boolean;
};
export function listClients(executor: Executor, query: ClientQuery) {
  return executor
    .select()
    .from(oauthClients)
    .where(
      and(
        query.q === undefined
          ? undefined
          : or(
              ilike(oauthClients.name, `%${query.q}%`),
              ilike(oauthClients.clientId, `%${query.q}%`),
            ),
        query.organizationId === undefined
          ? undefined
          : eq(oauthClients.organizationId, query.organizationId),
        query.disabled === undefined
          ? undefined
          : eq(oauthClients.disabled, query.disabled),
        beforeCursor(oauthClients.id, query.cursor),
      ),
    )
    .orderBy(desc(oauthClients.id))
    .limit(query.limit + 1);
}
export async function findClient(executor: Executor, clientId: string) {
  const [row] = await executor
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.clientId, clientId));
  return row ?? null;
}
/** Serialise client configuration, token revocation and secret rotation. */
export async function lockClient(executor: Executor, clientId: string) {
  const [row] = await executor
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.clientId, clientId))
    .for("update");
  return row ?? null;
}
export async function createClient(executor: Executor, input: ClientInput) {
  const [row] = await executor
    .insert(oauthClients)
    .values({ ...input, id: createId() })
    .returning();
  return row!;
}
export async function updateClient(
  executor: Executor,
  clientId: string,
  patch: ClientPatch,
) {
  const [row] = await executor
    .update(oauthClients)
    .set(patch)
    .where(eq(oauthClients.clientId, clientId))
    .returning();
  return row ?? null;
}
export async function setClientDisabled(
  executor: Executor,
  clientId: string,
  disabled: boolean,
) {
  const [row] = await executor
    .update(oauthClients)
    .set({ disabled })
    .where(eq(oauthClients.clientId, clientId))
    .returning();
  return row ?? null;
}
export async function setClientSecret(
  executor: Executor,
  clientId: string,
  digest: string,
) {
  const [row] = await executor
    .update(oauthClients)
    .set({ clientSecret: digest })
    .where(eq(oauthClients.clientId, clientId))
    .returning();
  return row ?? null;
}
export async function linkClientResource(
  executor: Executor,
  clientId: string,
  resource: string,
) {
  const rows = await executor
    .insert(oauthClientResources)
    .values({ id: createId(), clientId, resourceId: resource })
    .onConflictDoNothing()
    .returning({ id: oauthClientResources.id });
  return { created: rows.length > 0 };
}
export async function unlinkClientResource(
  executor: Executor,
  clientId: string,
  resource: string,
) {
  const rows = await executor
    .delete(oauthClientResources)
    .where(
      and(
        eq(oauthClientResources.clientId, clientId),
        eq(oauthClientResources.resourceId, resource),
      ),
    )
    .returning({ id: oauthClientResources.id });
  return rows.length > 0;
}
export function listClientResources(executor: Executor, clientId: string) {
  return executor
    .select()
    .from(oauthClientResources)
    .where(eq(oauthClientResources.clientId, clientId))
    .orderBy(desc(oauthClientResources.id));
}

export async function countClientEntitlements(
  executor: Executor,
  clientId: string,
) {
  const [row] = await executor
    .select({ count: count() })
    .from(entitlements)
    .where(eq(entitlements.clientId, clientId));
  return row!.count;
}
export async function deleteClient(executor: Executor, clientId: string) {
  await executor
    .delete(oauthClients)
    .where(eq(oauthClients.clientId, clientId));
}
