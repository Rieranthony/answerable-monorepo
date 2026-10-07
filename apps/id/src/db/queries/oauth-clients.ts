import type {
  PlatformReadContext,
  PlatformWriteContext,
} from "../../services/platform-context.ts";
import type { TenantReadContext } from "../../services/tenant-context.ts";
import { lockClient } from "../locks.ts";
import { eraseTokensAndConsents } from "./oauth-tokens.ts";
import {
  count,
  and,
  desc,
  eq,
  sql,
  getTableColumns,
  isNull,
} from "drizzle-orm";

import type { PageQuery } from "../../http/pagination.ts";
import { beforeCursor, cursorPage, optionalEq, contains } from "./lists.ts";
import { createId } from "../../lib/id.ts";
import type { Executor } from "../client.ts";
import {
  entitlements,
  oauthClients,
  oauthClientResources,
  oauthRefreshTokens,
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
    | "scopes"
    | "clientCredentialsScopes"
    | "jwks"
    | "jwksUri"
    | "skipConsent"
  >
>;
export type ClientQuery = PageQuery & {
  q?: string;
  organizationId?: string;
  disabled?: boolean;
};
export async function listClients(
  context: PlatformReadContext,
  query: ClientQuery,
) {
  const { tx: executor } = context;
  return cursorPage(
    await executor
      .select(publicSelection)
      .from(oauthClients)
      .where(
        and(
          isNull(oauthClients.deletedAt),
          contains(query.q, oauthClients.name, oauthClients.clientId),
          optionalEq(oauthClients.organizationId, query.organizationId),
          optionalEq(oauthClients.disabled, query.disabled),
          beforeCursor(oauthClients.id, query.cursor),
        ),
      )
      .orderBy(desc(oauthClients.id))
      .limit(query.limit + 1),
    query.limit,
  );
}
function publicClientQuery(executor: Executor, clientId: string) {
  return executor
    .select(publicSelection)
    .from(oauthClients)
    .where(
      and(isNull(oauthClients.deletedAt), eq(oauthClients.clientId, clientId)),
    )
    .for("share");
}
/** A command waits on the share lock, then re-checks its authority. */
export async function readClient(
  context: PlatformReadContext | PlatformWriteContext,
  clientId: string,
) {
  const [row] = await publicClientQuery(context.tx, clientId);
  if ("revalidate" in context) await context.revalidate();
  return row ?? null;
}
export async function lockClientForCommand(
  context: PlatformWriteContext,
  clientId: string,
) {
  const { tx } = context;
  const row = await lockClient(tx, clientId);
  await context.revalidate();
  return row;
}
/** Client registration can be shared; this existence check grants no permission. */
export async function findClientForAccess(
  context: TenantReadContext<"directory">,
  clientId: string,
) {
  const { tx } = context;
  const [row] = await tx
    .select({ id: oauthClients.id })
    .from(oauthClients)
    .where(
      and(isNull(oauthClients.deletedAt), eq(oauthClients.clientId, clientId)),
    );
  return row ?? null;
}

export async function createClient(
  context: PlatformWriteContext,
  input: ClientInput,
) {
  const { tx: executor } = context;
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
  const { tx: executor } = context;
  const [row] = await executor
    .update(oauthClients)
    .set(patch)
    .where(
      and(isNull(oauthClients.deletedAt), eq(oauthClients.clientId, clientId)),
    )
    .returning();
  return row ?? null;
}
export async function setClientDisabled(
  context: PlatformWriteContext,
  clientId: string,
  disabled: boolean,
) {
  const { tx: executor } = context;
  const [row] = await executor
    .update(oauthClients)
    .set({ disabled })
    .where(
      and(isNull(oauthClients.deletedAt), eq(oauthClients.clientId, clientId)),
    )
    .returning();
  return row ?? null;
}
export async function setClientSecret(
  context: PlatformWriteContext,
  clientId: string,
  digest: string,
) {
  const { tx: executor } = context;
  const [row] = await executor
    .update(oauthClients)
    .set({ clientSecret: digest })
    .where(
      and(isNull(oauthClients.deletedAt), eq(oauthClients.clientId, clientId)),
    )
    .returning();
  return row ?? null;
}
export async function linkClientResource(
  context: PlatformWriteContext,
  clientId: string,
  resource: string,
) {
  const { tx: executor } = context;
  const rows = await executor
    .insert(oauthClientResources)
    .values({ id: createId(), clientId, resourceId: resource })
    .onConflictDoNothing()
    .returning({
      id: oauthClientResources.id,
      deletedAt: oauthClientResources.deletedAt,
    });
  return { created: rows.length > 0, relationship: rows[0] ?? null };
}
export async function unlinkClientResource(
  context: PlatformWriteContext,
  clientId: string,
  resource: string,
) {
  const { tx: executor } = context;
  const rows = await executor
    .update(oauthClientResources)
    .set({ deletedAt: sql`now()` })
    .where(
      and(
        isNull(oauthClientResources.deletedAt),
        eq(oauthClientResources.clientId, clientId),
        eq(oauthClientResources.resourceId, resource),
      ),
    )
    .returning({
      deletedAt: oauthClientResources.deletedAt,
      id: oauthClientResources.id,
    });
  return rows[0] ?? null;
}
export function listClientResources(
  context: PlatformReadContext,
  clientId: string,
) {
  const { tx: executor } = context;
  return executor
    .select()
    .from(oauthClientResources)
    .where(
      and(
        isNull(oauthClientResources.deletedAt),
        eq(oauthClientResources.clientId, clientId),
      ),
    )
    .orderBy(desc(oauthClientResources.id));
}

export async function countClientEntitlements(
  context: PlatformWriteContext,
  clientId: string,
) {
  const { tx: executor } = context;
  const [row] = await executor
    .select({ count: count() })
    .from(entitlements)
    .where(
      and(isNull(entitlements.deletedAt), eq(entitlements.clientId, clientId)),
    );
  return row!.count;
}
export async function deleteClient(
  context: PlatformWriteContext,
  clientId: string,
) {
  const { tx } = context;
  // Caller holds the client FOR UPDATE. Lock refresh parents in a separate
  // statement: a cross-client access row can reference one while deletion waits.
  await tx
    .select({ id: oauthRefreshTokens.id })
    .from(oauthRefreshTokens)
    .where(eq(oauthRefreshTokens.clientId, clientId))
    .orderBy(oauthRefreshTokens.id)
    .for("update");
  const { deletedAccessTokens, deletedRefreshTokens, softDeletedConsents } =
    await eraseTokensAndConsents(tx, "clientId", clientId);
  const softDeletedClientResources = await tx
    .update(oauthClientResources)
    .set({ deletedAt: sql`now()` })
    .where(
      and(
        isNull(oauthClientResources.deletedAt),
        eq(oauthClientResources.clientId, clientId),
      ),
    )
    .returning({
      deletedAt: oauthClientResources.deletedAt,
      id: oauthClientResources.id,
      clientId: oauthClientResources.clientId,
      resourceId: oauthClientResources.resourceId,
    });
  const [row] = await tx
    .update(oauthClients)
    .set({ deletedAt: sql`now()`, disabled: true, clientSecret: null })
    .where(
      and(isNull(oauthClients.deletedAt), eq(oauthClients.clientId, clientId)),
    )
    .returning();
  return {
    row: row!,
    effects: {
      deletedAccessTokens,
      deletedRefreshTokens,
      softDeletedConsents,
      softDeletedClientResources,
    },
  };
}
