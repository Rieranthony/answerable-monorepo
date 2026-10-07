import {
  revokeSessionGrantContexts,
  revokeUserGrantContexts,
} from "../db/queries/grant-contexts.ts";
import {
  type PlatformUsersContext,
  type PlatformReadContext,
} from "./platform-context.ts";
import * as queries from "../db/queries/sessions.ts";
import { userExists, lockUser } from "../db/queries/users.ts";
import {
  revokeSessionTokens,
  revokeUserTokens,
} from "../db/queries/oauth-tokens.ts";
import { recordCommandEvent } from "./audit.ts";
import type { PageQuery } from "../http/pagination.ts";
import { found } from "../http/problem.ts";

const notFound = "User or session not found";
export async function listUserSessions(
  context: PlatformReadContext,
  userId: string,
  page: PageQuery,
) {
  found(await userExists(context, userId), notFound);
  return queries.listUserSessions(context, userId, page);
}
export async function revokeUserSession(
  context: PlatformUsersContext,
  userId: string,
  sessionId: string,
) {
  found(await lockUser(context, userId), notFound);
  const before = found(
    await queries.findUserSession(context, userId, sessionId),
    notFound,
  );
  // Deleting the session clears token sessionId foreign keys.
  const tokens = await revokeSessionTokens(context, sessionId);
  const revokedGrantContexts = await revokeSessionGrantContexts(
    context,
    userId,
    sessionId,
  );
  await queries.deleteSession(context, userId, sessionId);
  await recordCommandEvent(context, {
    organizationId: null,
    targetType: "session",
    targetId: sessionId,
    action: "session.revoked",
    data: {
      userId,
      before: {
        id: before.id,
        createdAt: before.createdAt,
        expiresAt: before.expiresAt,
      },
      after: null,
      sessionIds: [sessionId],
      revokedGrantContexts,
      ...tokens,
    },
  });
}
export async function revokeUserSessions(
  context: PlatformUsersContext,
  userId: string,
) {
  found(await lockUser(context, userId), notFound);
  const sessionIds = await queries.deleteUserSessionIds(context, userId);
  const revoked = sessionIds.length;
  const tokens = await revokeUserTokens(context, userId);
  const revokedGrantContexts = await revokeUserGrantContexts(context, userId);
  await recordCommandEvent(context, {
    organizationId: null,
    targetType: "user",
    targetId: userId,
    action: "session.revoked_all",
    data: {
      userId,
      sessions: revoked,
      sessionIds,
      revokedGrantContexts,
      ...tokens,
    },
  });
  return {
    revoked,
    changed:
      revoked > 0 ||
      tokens.refreshTokens > 0 ||
      tokens.accessTokens > 0 ||
      revokedGrantContexts.length > 0,
  };
}
