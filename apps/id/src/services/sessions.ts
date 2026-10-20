import { revokeUserGrantContexts } from "../db/queries/grant-contexts.ts";
import {
  type PlatformUsersContext,
  type PlatformReadContext,
} from "./platform-context.ts";
import * as queries from "../db/queries/sessions.ts";
import { userExists, lockUser } from "../db/queries/users.ts";
import { revokeUserTokens } from "../db/queries/oauth-tokens.ts";
import { recordCommandEvent } from "./audit.ts";
import type { PageQuery } from "../http/pagination.ts";
import { found } from "../http/problem.ts";

const notFound = "User not found";
export async function listUserSessions(
  context: PlatformReadContext,
  userId: string,
  page: PageQuery,
) {
  found(await userExists(context, userId), notFound);
  return queries.listUserSessions(context, userId, page);
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
