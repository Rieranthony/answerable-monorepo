import {
  requirePlatformUsersContext,
  requirePlatformWriteContext,
  type PlatformUsersContext,
  type PlatformWriteContext,
} from "../../services/platform-context.ts";
import { eq, and, inArray, isNull, sql } from "drizzle-orm";
import type { Executor } from "../client.ts";
import {
  oauthRefreshTokens,
  oauthAccessTokens,
  oauthClients,
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
  const { tx } = requirePlatformUsersContext(context);
  return revokeTokens(tx, "userId", userId);
}

export function revokeClientTokens(
  context: PlatformWriteContext,
  clientId: string,
) {
  const { tx } = requirePlatformWriteContext(context);
  return revokeTokens(tx, "clientId", clientId);
}

export function revokeSessionTokens(
  context: PlatformUsersContext,
  sessionId: string,
) {
  const { tx } = requirePlatformUsersContext(context);
  return revokeTokens(tx, "sessionId", sessionId);
}

/** Immutable client ownership identifies machine tenant; user grants need their own context. */
export async function revokeOrganizationMachineTokens(
  context: PlatformWriteContext,
  organizationId: string,
) {
  const { tx: executor } = requirePlatformWriteContext(context);
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
