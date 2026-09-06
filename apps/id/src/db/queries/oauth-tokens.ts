import { and, inArray, isNull, sql } from "drizzle-orm";
import type { Executor } from "../client.ts";
import { oauthRefreshTokens, oauthAccessTokens } from "../schema/index.ts";

async function revokeTokens(
  executor: Executor,
  field: "userId" | "clientId" | "sessionId",
  ids: string[],
) {
  if (!ids.length) return { refreshTokens: 0, accessTokens: 0 };
  const refresh = await executor
    .update(oauthRefreshTokens)
    .set({ revoked: sql`now()` })
    .where(
      and(
        inArray(oauthRefreshTokens[field], ids),
        isNull(oauthRefreshTokens.revoked),
      ),
    )
    .returning({ id: oauthRefreshTokens.id });
  const access = await executor
    .update(oauthAccessTokens)
    .set({ revoked: sql`now()` })
    .where(
      and(
        inArray(oauthAccessTokens[field], ids),
        isNull(oauthAccessTokens.revoked),
      ),
    )
    .returning({ id: oauthAccessTokens.id });
  return { refreshTokens: refresh.length, accessTokens: access.length };
}

export function revokeUserTokens(executor: Executor, userIds: string[]) {
  return revokeTokens(executor, "userId", userIds);
}

export function revokeClientTokens(executor: Executor, clientIds: string[]) {
  return revokeTokens(executor, "clientId", clientIds);
}

export function revokeSessionTokens(executor: Executor, sessionIds: string[]) {
  return revokeTokens(executor, "sessionId", sessionIds);
}
