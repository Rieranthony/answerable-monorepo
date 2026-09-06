import type { Database, Executor } from "../db/client.ts";
import * as queries from "../db/queries/users.ts";
import { recordAuditEvent } from "../db/queries/audit.ts";
import { deleteUserSessions } from "../db/queries/sessions.ts";
import { revokeUserTokens } from "../db/queries/oauth-tokens.ts";
import { cursorPage } from "../http/pagination.ts";
import { ProblemError } from "../http/problem.ts";
import type { Actor } from "./actor.ts";

function requireUser<T>(row: T | null): T {
  if (!row) throw new ProblemError(404, "not_found", "User not found");
  return row;
}
function audit(
  tx: Executor,
  actor: Actor,
  userId: string,
  action: string,
  data: Record<string, unknown>,
) {
  return recordAuditEvent(tx, {
    ...actor,
    organizationId: null,
    targetId: userId,
    targetType: "user",
    action,
    data,
    outcome: "success",
  });
}
export async function listUsers(db: Database, query: queries.UserQuery) {
  return cursorPage(await queries.listUsers(db, query), query.limit);
}
export async function getUser(db: Database, userId: string) {
  return requireUser(await queries.findUser(db, userId));
}
export function disableUser(db: Database, actor: Actor, userId: string) {
  return db.transaction(async (tx) => {
    const existing = requireUser(await queries.lockUser(tx, userId));
    if (existing.status === "disabled")
      throw new ProblemError(
        409,
        "user_already_disabled",
        "User is already disabled",
      );
    const row = await queries.setUserStatus(tx, userId, "disabled");
    const sessions = await deleteUserSessions(tx, [userId]);
    const tokens = await revokeUserTokens(tx, [userId]);
    await audit(tx, actor, userId, "user.disabled", { sessions, ...tokens });
    return row!;
  });
}
export function enableUser(db: Database, actor: Actor, userId: string) {
  return db.transaction(async (tx) => {
    const existing = requireUser(await queries.lockUser(tx, userId));
    if (existing.retiredEmail !== null)
      throw new ProblemError(
        409,
        "user_email_retired",
        "User email has been retired",
      );
    if (existing.status === "active")
      throw new ProblemError(
        409,
        "user_already_active",
        "User is already active",
      );
    if (existing.status === "inert")
      throw new ProblemError(
        409,
        "user_inert",
        "Inert users activate at first login",
      );
    const row = await queries.setUserStatus(tx, userId, "active");
    await audit(tx, actor, userId, "user.enabled", { status: "active" });
    return row!;
  });
}
export function retireUserEmail(db: Database, actor: Actor, userId: string) {
  return db.transaction(async (tx) => {
    const existing = requireUser(await queries.lockUser(tx, userId));
    if (existing.status !== "disabled")
      throw new ProblemError(
        409,
        "user_not_disabled",
        "Disable the user before retiring their email",
      );
    if (existing.retiredEmail !== null)
      throw new ProblemError(
        409,
        "user_email_already_retired",
        "User email is already retired",
      );
    const row = await queries.retireUserEmail(tx, userId);
    await audit(tx, actor, userId, "user.email_retired", {
      retiredEmail: row.retiredEmail,
    });
    return row;
  });
}
export function eraseUser(
  db: Database,
  actor: Actor,
  userId: string,
  confirm: string,
) {
  return db.transaction(async (tx) => {
    requireUser(await queries.lockUser(tx, userId));
    if (confirm !== userId)
      throw new ProblemError(
        400,
        "confirmation_mismatch",
        "Confirmation must match the user ID",
      );
    await queries.deleteUser(tx, userId);
    await audit(tx, actor, userId, "user.erased", {});
  });
}
