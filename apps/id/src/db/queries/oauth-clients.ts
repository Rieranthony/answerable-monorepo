import {
  requirePlatformReadContext,
  requirePlatformWriteContext,
  type PlatformReadContext,
  type PlatformWriteContext,
} from "../../services/platform-context.ts";
import {
  requireTenantDirectoryContext,
  type TenantReadContext,
} from "../../services/tenant-context.ts";
import { lockClient } from "../client-lock.ts";
import {
  count,
  and,
  desc,
  eq,
  ilike,
  inArray,
  or,
  sql,
  getTableColumns,
} from "drizzle-orm";

import { beforeCursor, type PageQuery } from "../../http/pagination.ts";
import { createId } from "../../lib/id.ts";
import type { Executor } from "../client.ts";
import {
  entitlements,
  oauthClients,
  oauthClientResources,
  oauthAccessTokens,
  oauthRefreshTokens,
  oauthConsents,
} from "../schema/index.ts";

const { clientSecret, ...clientColumns } = getTableColumns(oauthClients);
const publicSelection = {
  ...clientColumns,
  hasClientSecret: sql<boolean>`${clientSecret} is not null`,
};

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
export function listClients(context: PlatformReadContext, query: ClientQuery) {
  const { tx: executor } = requirePlatformReadContext(context);
  return executor
    .select(publicSelection)
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
function publicClientQuery(executor: Executor, clientId: string) {
  return executor
    .select(publicSelection)
    .from(oauthClients)
    .where(eq(oauthClients.clientId, clientId))
    .for("share");
}
export async function readClient(
  context: PlatformReadContext,
  clientId: string,
) {
  const { tx } = requirePlatformReadContext(context);
  const [row] = await publicClientQuery(tx, clientId);
  return row ?? null;
}
export async function readClientForPolicy(
  context: PlatformWriteContext,
  clientId: string,
) {
  const { tx } = requirePlatformWriteContext(context);
  const [row] = await publicClientQuery(tx, clientId);
  return row ?? null;
}
export function lockClientForCommand(
  context: PlatformWriteContext,
  clientId: string,
) {
  const { tx } = requirePlatformWriteContext(context);
  return lockClient(tx, clientId);
}
/** Client registration can be shared; this existence check grants no permission. */
export async function findClientForAccess(
  context: TenantReadContext<"directory">,
  clientId: string,
) {
  const { tx } = requireTenantDirectoryContext(context);
  const [row] = await tx
    .select({ id: oauthClients.id })
    .from(oauthClients)
    .where(eq(oauthClients.clientId, clientId));
  return row ?? null;
}

export async function createClient(
  context: PlatformWriteContext,
  input: ClientInput,
) {
  const { tx: executor } = requirePlatformWriteContext(context);
  const [row] = await executor
    .insert(oauthClients)
    .values({ ...input, id: createId() })
    .returning();
  return row!;
}
export async function updateClient(
  context: PlatformWriteContext,
  clientId: string,
  patch: ClientPatch,
) {
  const { tx: executor } = requirePlatformWriteContext(context);
  const [row] = await executor
    .update(oauthClients)
    .set(patch)
    .where(eq(oauthClients.clientId, clientId))
    .returning();
  return row ?? null;
}
export async function setClientDisabled(
  context: PlatformWriteContext,
  clientId: string,
  disabled: boolean,
) {
  const { tx: executor } = requirePlatformWriteContext(context);
  const [row] = await executor
    .update(oauthClients)
    .set({ disabled })
    .where(eq(oauthClients.clientId, clientId))
    .returning();
  return row ?? null;
}
export async function setClientSecret(
  context: PlatformWriteContext,
  clientId: string,
  digest: string,
) {
  const { tx: executor } = requirePlatformWriteContext(context);
  const [row] = await executor
    .update(oauthClients)
    .set({ clientSecret: digest })
    .where(eq(oauthClients.clientId, clientId))
    .returning();
  return row ?? null;
}
export async function linkClientResource(
  context: PlatformWriteContext,
  clientId: string,
  resource: string,
) {
  const { tx: executor } = requirePlatformWriteContext(context);
  const rows = await executor
    .insert(oauthClientResources)
    .values({ id: createId(), clientId, resourceId: resource })
    .onConflictDoNothing()
    .returning({ id: oauthClientResources.id });
  return { created: rows.length > 0 };
}
export async function unlinkClientResource(
  context: PlatformWriteContext,
  clientId: string,
  resource: string,
) {
  const { tx: executor } = requirePlatformWriteContext(context);
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
export function listClientResources(
  context: PlatformReadContext,
  clientId: string,
) {
  const { tx: executor } = requirePlatformReadContext(context);
  return executor
    .select()
    .from(oauthClientResources)
    .where(eq(oauthClientResources.clientId, clientId))
    .orderBy(desc(oauthClientResources.id));
}

export async function countClientEntitlements(
  context: PlatformWriteContext,
  clientId: string,
) {
  const { tx: executor } = requirePlatformWriteContext(context);
  const [row] = await executor
    .select({ count: count() })
    .from(entitlements)
    .where(eq(entitlements.clientId, clientId));
  return row!.count;
}
export async function deleteClient(
  context: PlatformWriteContext,
  clientId: string,
) {
  const { tx } = requirePlatformWriteContext(context);
  // Caller holds the client FOR UPDATE. Lock refresh parents in a separate
  // statement: a cross-client access row can reference one while deletion waits.
  await tx
    .select({ id: oauthRefreshTokens.id })
    .from(oauthRefreshTokens)
    .where(eq(oauthRefreshTokens.clientId, clientId))
    .orderBy(oauthRefreshTokens.id)
    .for("update");
  const deletedAccessTokens = await tx
    .delete(oauthAccessTokens)
    .where(
      or(
        eq(oauthAccessTokens.clientId, clientId),
        inArray(
          oauthAccessTokens.refreshId,
          tx
            .select({ id: oauthRefreshTokens.id })
            .from(oauthRefreshTokens)
            .where(eq(oauthRefreshTokens.clientId, clientId)),
        ),
      ),
    )
    .returning({
      id: oauthAccessTokens.id,
      userId: oauthAccessTokens.userId,
      clientId: oauthAccessTokens.clientId,
      sessionId: oauthAccessTokens.sessionId,
      refreshId: oauthAccessTokens.refreshId,
      scopes: oauthAccessTokens.scopes,
      resources: oauthAccessTokens.resources,
      expiresAt: oauthAccessTokens.expiresAt,
      revoked: oauthAccessTokens.revoked,
    });
  const deletedRefreshTokens = await tx
    .delete(oauthRefreshTokens)
    .where(eq(oauthRefreshTokens.clientId, clientId))
    .returning({
      id: oauthRefreshTokens.id,
      userId: oauthRefreshTokens.userId,
      clientId: oauthRefreshTokens.clientId,
      sessionId: oauthRefreshTokens.sessionId,
      scopes: oauthRefreshTokens.scopes,
      resources: oauthRefreshTokens.resources,
      expiresAt: oauthRefreshTokens.expiresAt,
      revoked: oauthRefreshTokens.revoked,
    });
  const deletedConsents = await tx
    .delete(oauthConsents)
    .where(eq(oauthConsents.clientId, clientId))
    .returning({
      id: oauthConsents.id,
      userId: oauthConsents.userId,
      clientId: oauthConsents.clientId,
      scopes: oauthConsents.scopes,
      resources: oauthConsents.resources,
    });
  const deletedClientResources = await tx
    .delete(oauthClientResources)
    .where(eq(oauthClientResources.clientId, clientId))
    .returning({
      id: oauthClientResources.id,
      clientId: oauthClientResources.clientId,
      resourceId: oauthClientResources.resourceId,
    });
  await tx.delete(oauthClients).where(eq(oauthClients.clientId, clientId));
  return {
    deletedAccessTokens,
    deletedRefreshTokens,
    deletedConsents,
    deletedClientResources,
  };
}
