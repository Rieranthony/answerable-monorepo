import { eq } from "drizzle-orm";
import { members, oauthResources, systemBindings } from "../db/schema/index.ts";
import { hasPlatformWriter } from "../db/queries/grants.ts";
import { revokeUserGrantContexts } from "../db/queries/grant-contexts.ts";
import {
  requirePlatformWriteContext,
  type PlatformWriteContext,
} from "./platform-context.ts";
import {
  requirePlatformUsersContext,
  type PlatformUsersContext,
} from "./platform-context.ts";
import { type PlatformReadContext } from "./platform-context.ts";
import type { Executor } from "../db/client.ts";
import * as queries from "../db/queries/users.ts";
import { recordAuditEvent } from "../db/queries/audit.ts";
import { deleteUserSessionIds } from "../db/queries/sessions.ts";
import { revokeUserTokens } from "../db/queries/oauth-tokens.ts";
import { cursorPage } from "../http/pagination.ts";
import { ProblemError } from "../http/problem.ts";
import type { Actor } from "./actor.ts";

function requireUser<T>(row: T | null): T {
  if (!row) throw new ProblemError(404, "not_found", "User not found");
  return row;
}
function state(row: NonNullable<Awaited<ReturnType<typeof queries.lockUser>>>) {
  return {
    id: row.id,
    status: row.status,
    disabledAt: row.disabledAt,
    emailRetired: row.retiredEmail !== null,
  };
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
    schemaVersion: [
      "user.erased",
      "user.disabled",
      "user.disable_unchanged",
    ].includes(action)
      ? 2
      : 1,
  });
}
export async function listUsers(
  context: PlatformReadContext,
  query: queries.UserQuery,
) {
  return cursorPage(await queries.listUsers(context, query), query.limit);
}
export async function getUser(context: PlatformReadContext, userId: string) {
  return requireUser(await queries.findUser(context, userId));
}
// Discover membership only after locking the user: concurrent membership inserts
// need the user foreign-key lock. Do not wait for the platform lock while holding
// this user lock; other authority writers acquire these locks in the reverse order.
async function protectPlatformUser(tx: Executor, userId: string) {
  const [binding] = await tx
    .select({ resource: oauthResources.identifier })
    .from(systemBindings)
    .innerJoin(
      members,
      eq(members.organizationId, systemBindings.organizationId),
    )
    .innerJoin(oauthResources, eq(oauthResources.id, systemBindings.resourceId))
    .where(eq(members.userId, userId));
  if (
    binding &&
    (await hasPlatformWriter(tx, { ...binding, noWait: true })) &&
    !(await hasPlatformWriter(tx, {
      ...binding,
      noWait: true,
      excludingUserId: userId,
    }))
  )
    throw new ProblemError(
      409,
      "last_platform_administrator",
      "Keep an effective platform administrator before disabling or erasing this user",
    );
}
export async function disableUser(
  context: PlatformUsersContext,
  userId: string,
) {
  const { tx, actor } = requirePlatformUsersContext(context);
  const existing = requireUser(await queries.lockUser(context, userId));
  await protectPlatformUser(tx, userId);
  const stateChanged = existing.status !== "disabled";
  const row = stateChanged
    ? (await queries.setUserStatus(context, userId, "disabled"))!
    : existing;
  const revokedGrantContexts = await revokeUserGrantContexts(context, userId);
  const sessionIds = await deleteUserSessionIds(context, userId);
  const tokens = await revokeUserTokens(context, userId);
  const changed =
    stateChanged ||
    revokedGrantContexts.length > 0 ||
    sessionIds.length > 0 ||
    tokens.refreshTokens > 0 ||
    tokens.accessTokens > 0;
  await audit(
    tx,
    actor,
    userId,
    changed ? "user.disabled" : "user.disable_unchanged",
    {
      before: state(existing),
      after: state(row),
      sessions: sessionIds.length,
      sessionIds,
      revokedGrantContexts,
      ...tokens,
    },
  );
  return { row, changed };
}
export async function enableUser(
  context: PlatformUsersContext,
  userId: string,
) {
  const { tx, actor } = requirePlatformUsersContext(context);
  const existing = requireUser(await queries.lockUser(context, userId));
  if (existing.retiredEmail !== null)
    throw new ProblemError(
      409,
      "user_email_retired",
      "User email has been retired",
    );
  if (existing.status === "inert")
    throw new ProblemError(
      409,
      "user_inert",
      "Inert users activate at first login",
    );
  const changed = existing.status !== "active";
  const row = changed
    ? (await queries.setUserStatus(context, userId, "active"))!
    : existing;
  await audit(
    tx,
    actor,
    userId,
    changed ? "user.enabled" : "user.enable_unchanged",
    { before: state(existing), after: state(row) },
  );
  return { row, changed };
}
export async function retireUserEmail(
  context: PlatformUsersContext,
  userId: string,
) {
  const { tx, actor } = requirePlatformUsersContext(context);
  const existing = requireUser(await queries.lockUser(context, userId));
  if (existing.status !== "disabled")
    throw new ProblemError(
      409,
      "user_not_disabled",
      "Disable the user before retiring their email",
    );
  const changed = existing.retiredEmail === null;
  const row = changed
    ? await queries.retireUserEmail(context, userId)
    : existing;
  await audit(
    tx,
    actor,
    userId,
    changed ? "user.email_retired" : "user.email_retirement_unchanged",
    { before: state(existing), after: state(row) },
  );
  return { row, changed };
}
export async function eraseUser(
  context: PlatformWriteContext,
  userId: string,
  confirm: string,
) {
  const { tx, actor } = requirePlatformWriteContext(context);
  const before = requireUser(await queries.lockUser(context, userId));
  if (confirm !== userId)
    throw new ProblemError(
      400,
      "confirmation_mismatch",
      "Confirmation must match the user ID",
    );
  await protectPlatformUser(tx, userId);
  const { effects, deletedGrantContexts } = requireUser(
    await queries.deleteUser(context, userId),
  );
  await audit(tx, actor, userId, "user.erased", {
    before: state(before),
    after: null,
    deletedGrantContexts,
    effects,
  });
}
