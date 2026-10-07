import {
  revokeSessionGrantContexts,
  revokeUserGrantContexts,
} from "../db/queries/grant-contexts.ts";
import {
  requirePlatformUsersContext,
  type PlatformUsersContext,
  type PlatformReadContext,
} from "./platform-context.ts";
import type { Executor } from "../db/client.ts";
import * as queries from "../db/queries/sessions.ts";
import { userExists, lockUser } from "../db/queries/users.ts";
import {
  revokeSessionTokens,
  revokeUserTokens,
} from "../db/queries/oauth-tokens.ts";
import { recordAuditEvent, type AuditAction } from "../db/queries/audit.ts";
import type { PageQuery } from "../http/pagination.ts";
import { ProblemError } from "../http/problem.ts";
import type { Actor } from "./actor.ts";

function requireRow<T>(row: T | null): T {
  if (!row)
    throw new ProblemError(404, "not_found", "User or session not found");
  return row;
}
function audit(
  tx: Executor,
  actor: Actor,
  targetId: string,
  action: AuditAction,
  data: Record<string, unknown>,
  targetType = "session",
) {
  return recordAuditEvent(tx, {
    ...actor,
    organizationId: null,
    targetId,
    targetType,
    action,
    data,
    outcome: "success",
  });
}
export async function listUserSessions(
  context: PlatformReadContext,
  userId: string,
  page: PageQuery,
) {
  if (!(await userExists(context, userId)))
    throw new ProblemError(404, "not_found", "User or session not found");
  return queries.listUserSessions(context, userId, page);
}
export async function revokeUserSession(
  context: PlatformUsersContext,
  userId: string,
  sessionId: string,
) {
  const { tx, actor } = requirePlatformUsersContext(context);
  requireRow(await lockUser(context, userId));
  const before = requireRow(
    await queries.findUserSession(context, userId, sessionId),
  );
  // Deleting the session clears token sessionId foreign keys.
  const tokens = await revokeSessionTokens(context, sessionId);
  const revokedGrantContexts = await revokeSessionGrantContexts(
    context,
    userId,
    sessionId,
  );
  await queries.deleteSession(context, userId, sessionId);
  await audit(tx, actor, sessionId, "session.revoked", {
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
  });
}
export async function revokeUserSessions(
  context: PlatformUsersContext,
  userId: string,
) {
  const { tx, actor } = requirePlatformUsersContext(context);
  requireRow(await lockUser(context, userId));
  const sessionIds = await queries.deleteUserSessionIds(context, userId);
  const revoked = sessionIds.length;
  const tokens = await revokeUserTokens(context, userId);
  const revokedGrantContexts = await revokeUserGrantContexts(context, userId);
  await audit(
    tx,
    actor,
    userId,
    "session.revoked_all",
    {
      userId,
      sessions: revoked,
      sessionIds,
      revokedGrantContexts,
      ...tokens,
    },
    "user",
  );
  return {
    revoked,
    changed:
      revoked > 0 ||
      tokens.refreshTokens > 0 ||
      tokens.accessTokens > 0 ||
      revokedGrantContexts.length > 0,
  };
}
