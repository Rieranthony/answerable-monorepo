import type {
  PlatformUsersContext,
  PlatformWriteContext,
} from "../../services/platform-context.ts";
import { eq, and, inArray, isNull, or, sql } from "drizzle-orm";
import type { Executor } from "../client.ts";
import {
  oauthRefreshTokens,
  oauthAccessTokens,
  oauthClients,
  oauthConsents,
} from "../schema/index.ts";

async function revokeTokens(
  executor: Executor,
  field: "userId" | "clientId" | "sessionId",
  id: string,
) {
  const refresh = await executor
    .update(oauthRefreshTokens)
    .set({ revoked: sql`now()` })
    .where(
      and(
        eq(oauthRefreshTokens[field], id),
        isNull(oauthRefreshTokens.revoked),
      ),
    )
    .returning({
      id: oauthRefreshTokens.id,
      userId: oauthRefreshTokens.userId,
    });
  const access = await executor
    .update(oauthAccessTokens)
    .set({ revoked: sql`now()` })
    .where(
      and(eq(oauthAccessTokens[field], id), isNull(oauthAccessTokens.revoked)),
    )
    .returning({ id: oauthAccessTokens.id, userId: oauthAccessTokens.userId });
  return {
    refreshTokens: refresh.length,
    accessTokens: access.length,
    revokedTokens: { refresh, access },
  };
}

export function revokeUserTokens(
  context: PlatformUsersContext,
  userId: string,
) {
  const { tx } = context;
  return revokeTokens(tx, "userId", userId);
}

export function revokeClientTokens(
  context: PlatformWriteContext,
  clientId: string,
) {
  const { tx } = context;
  return revokeTokens(tx, "clientId", clientId);
}

export function revokeSessionTokens(
  context: PlatformUsersContext,
  sessionId: string,
) {
  const { tx } = context;
  return revokeTokens(tx, "sessionId", sessionId);
}

/** Immutable client ownership identifies machine tenant; user grants need their own context. */
export async function revokeOrganizationMachineTokens(
  context: PlatformWriteContext,
  organizationId: string,
) {
  const { tx: executor } = context;
  const rows = await executor
    .update(oauthAccessTokens)
    .set({ revoked: sql`now()` })
    .where(
      and(
        isNull(oauthAccessTokens.userId),
        isNull(oauthAccessTokens.revoked),
        inArray(
          oauthAccessTokens.clientId,
          executor
            .select({ clientId: oauthClients.clientId })
            .from(oauthClients)
            .where(eq(oauthClients.organizationId, organizationId)),
        ),
      ),
    )
    .returning({ id: oauthAccessTokens.id });
  return rows.map((row) => row.id);
}

/** Erase a user's or a client's protocol rows, in this order: delete its
 * access tokens and those its refresh tokens issued, delete its refresh
 * tokens, soft-delete its consents. The caller holds the owner's lock and
 * the refresh rows' locks; the rows returned are the actual effects, without
 * token values. */
export async function eraseTokensAndConsents(
  executor: Executor,
  field: "userId" | "clientId",
  id: string,
) {
  const deletedAccessTokens = await executor
    .delete(oauthAccessTokens)
    .where(
      or(
        eq(oauthAccessTokens[field], id),
        inArray(
          oauthAccessTokens.refreshId,
          executor
            .select({ id: oauthRefreshTokens.id })
            .from(oauthRefreshTokens)
            .where(eq(oauthRefreshTokens[field], id)),
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
  const deletedRefreshTokens = await executor
    .delete(oauthRefreshTokens)
    .where(eq(oauthRefreshTokens[field], id))
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
  const softDeletedConsents = await executor
    .update(oauthConsents)
    .set({ deletedAt: sql`now()` })
    .where(and(isNull(oauthConsents.deletedAt), eq(oauthConsents[field], id)))
    .returning({
      deletedAt: oauthConsents.deletedAt,
      id: oauthConsents.id,
      userId: oauthConsents.userId,
      clientId: oauthConsents.clientId,
      scopes: oauthConsents.scopes,
      resources: oauthConsents.resources,
    });
  return { deletedAccessTokens, deletedRefreshTokens, softDeletedConsents };
}
