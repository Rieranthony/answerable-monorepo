import type { Database, Executor } from "../db/client.ts";
import * as queries from "../db/queries/sessions.ts";
import { findUser, lockUser } from "../db/queries/users.ts";
import {
  revokeSessionTokens,
  revokeUserTokens,
} from "../db/queries/oauth-tokens.ts";
import { recordAuditEvent } from "../db/queries/audit.ts";
import { cursorPage, type PageQuery } from "../http/pagination.ts";
import { ProblemError } from "../http/problem.ts";
import type { Actor } from "./actor.ts";

function requireRow<T>(row: T | null): T {
  if (!row)
    throw new ProblemError(
      404,
      "not_found",
      "User, member or session not found",
    );
  return row;
}
function audit(
  tx: Executor,
  actor: Actor,
  organizationId: string | null,
  targetId: string,
  action: string,
  data: Record<string, unknown>,
) {
  return recordAuditEvent(tx, {
    ...actor,
    organizationId,
    targetId,
    targetType: "session",
    action,
    data,
    outcome: "success",
  });
}
export async function listUserSessions(
  db: Database,
  userId: string,
  page: PageQuery,
) {
  requireRow(await findUser(db, userId));
  return cursorPage(
    await queries.listUserSessions(db, userId, page),
    page.limit,
  );
}
export function revokeUserSession(
  db: Database,
  actor: Actor,
  userId: string,
  sessionId: string,
) {
  return db.transaction(async (tx) => {
    requireRow(await lockUser(tx, userId));
    requireRow(await queries.findUserSession(tx, userId, sessionId));
    // Deleting the session clears token sessionId foreign keys.
    await revokeSessionTokens(tx, [sessionId]);
    await queries.deleteSession(tx, userId, sessionId);
    await audit(tx, actor, null, sessionId, "session.revoked", { userId });
  });
}
async function revokeAll(
  tx: Executor,
  actor: Actor,
  userId: string,
  organizationId: string | null,
) {
  requireRow(await lockUser(tx, userId));
  const revoked = await queries.deleteUserSessions(tx, [userId]);
  const tokens = await revokeUserTokens(tx, [userId]);
  await audit(tx, actor, organizationId, userId, "session.revoked_all", {
    userId,
    sessions: revoked,
    ...tokens,
  });
  return { revoked };
}
export function revokeUserSessions(db: Database, actor: Actor, userId: string) {
  return db.transaction((tx) => revokeAll(tx, actor, userId, null));
}
export async function listMemberSessions(
  db: Database,
  organizationId: string,
  memberId: string,
  page: PageQuery,
) {
  const userId = requireRow(
    await queries.findMemberUserId(db, organizationId, memberId),
  );
  return listUserSessions(db, userId, page);
}
export function revokeMemberSessions(
  db: Database,
  actor: Actor,
  organizationId: string,
  memberId: string,
) {
  return db.transaction(async (tx) => {
    const userId = requireRow(
      await queries.findMemberUserId(tx, organizationId, memberId),
    );
    return revokeAll(tx, actor, userId, organizationId);
  });
}
