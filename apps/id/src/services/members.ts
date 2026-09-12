import { revokeMemberGrantContexts } from "../db/queries/grant-contexts.ts";
import { memberAccess } from "../db/queries/access.ts";
import * as queries from "../db/queries/members.ts";
import type { MemberWindow } from "../db/queries/groups.ts";
import type { Executor } from "../db/client.ts";
import {
  requireTenantMemberContext,
  requireTenantDirectoryContext,
  requireTenantMemberConfigurationContext,
  type TenantReadContext,
  type TenantMemberContext,
} from "./tenant-context.ts";
import { recordAuditEvent } from "../db/queries/audit.ts";
import { cursorPage } from "../http/pagination.ts";
import { ProblemError } from "../http/problem.ts";
import type { Actor } from "./actor.ts";
function requireRow<T>(row: T | null): T {
  if (!row)
    throw new ProblemError(
      404,
      "not_found",
      "Organisation or member not found",
    );
  return row;
}
function audit(
  tx: Executor,
  actor: Actor,
  organizationId: string,
  targetId: string,
  action: string,
  data: Record<string, unknown>,
) {
  return recordAuditEvent(tx, {
    ...actor,
    organizationId,
    targetId,
    targetType: "member",
    action,
    schemaVersion:
      action === "member.removed" || action === "member.removal_unchanged"
        ? 3
        : 2,
    data,
    outcome: "success",
  });
}
export async function listMembers(
  context: TenantReadContext<"directory">,
  query: queries.MemberQuery,
) {
  requireTenantDirectoryContext(context);
  return cursorPage(await queries.listMembers(context, query), query.limit);
}
export async function getMember(
  context: TenantReadContext<"directory">,
  memberId: string,
) {
  requireTenantDirectoryContext(context);
  return requireRow(await queries.findMember(context, memberId));
}
export async function updateWindow(
  context: TenantMemberContext,
  memberId: string,
  patch: MemberWindow,
  expected?: { id: string; revision: number },
) {
  const { tx, organizationId, actor } = requireTenantMemberContext(context);
  const before = requireRow(
    await queries.findMemberConfiguration(context, memberId),
  );
  if (
    expected &&
    (before.id !== expected.id || before.revision !== expected.revision)
  )
    throw new ProblemError(
      412,
      "revision_mismatch",
      "Member changed; read its configuration before issuing a new command",
    );
  const accessBefore = await memberAccess(context, memberId);
  const row = requireRow(
    await queries.updateMemberWindow(context, memberId, patch),
  );
  const accessAfter = await memberAccess(context, memberId);
  await audit(tx, actor, organizationId, memberId, "member.updated", {
    changes: patch,
    before: { ...before, access: accessBefore },
    after: {
      ...before,
      revision: row.revision,
      validFrom: row.validFrom,
      validUntil: row.validUntil,
      access: accessAfter,
    },
  });
  return { body: row, changed: row.revision !== before.revision };
}
export async function remove(context: TenantMemberContext, memberId: string) {
  const { tx, organizationId, actor } = requireTenantMemberContext(context);
  const before = requireRow(await queries.findMember(context, memberId));
  const accessBefore = await memberAccess(context, memberId);
  const row = requireRow(await queries.revokeMember(context, memberId));
  const { removedGrants, softDeletedGroups } =
    await queries.removeMemberAssignments(context, memberId);
  const revokedGrantContexts = await revokeMemberGrantContexts(
    context,
    memberId,
  );
  const accessAfter = await memberAccess(context, memberId);
  const unchanged =
    revokedGrantContexts.length === 0 &&
    before.membershipStatus === "revoked" &&
    removedGrants.length === 0 &&
    softDeletedGroups.length === 0;
  await audit(
    tx,
    actor,
    organizationId,
    memberId,
    unchanged ? "member.removal_unchanged" : "member.removed",
    {
      userId: row.userId,
      reason: "administrative_removal",
      before: {
        membershipStatus: before.membershipStatus,
        revokedAt: before.revokedAt,
        access: accessBefore,
      },
      after: {
        membershipStatus: row.status,
        revokedAt: row.revokedAt,
        access: accessAfter,
      },
      effects: { removedGrants, softDeletedGroups, revokedGrantContexts },
    },
  );
  return unchanged ? ("noop" as const) : ("applied" as const);
}

export async function reinstate(
  context: TenantMemberContext,
  memberId: string,
) {
  const { tx, organizationId, actor } = requireTenantMemberContext(context);
  const before = requireRow(await queries.findMember(context, memberId));
  const accessBefore = await memberAccess(context, memberId);
  const row = requireRow(await queries.reinstateMember(context, memberId));
  const accessAfter = await memberAccess(context, memberId);
  await audit(
    tx,
    actor,
    organizationId,
    memberId,
    before.membershipStatus === "active"
      ? "member.reinstatement_unchanged"
      : "member.reinstated",
    {
      userId: row.userId,
      reason: "administrative_reinstatement",
      before: {
        membershipStatus: before.membershipStatus,
        revokedAt: before.revokedAt,
        access: accessBefore,
      },
      after: {
        membershipStatus: row.status,
        revokedAt: row.revokedAt,
        access: accessAfter,
      },
    },
  );
  return requireRow(await queries.findMember(context, memberId));
}

export async function getMemberConfiguration(
  context: TenantMemberContext | TenantReadContext<"configuration">,
  memberId: string,
) {
  requireTenantMemberConfigurationContext(context);
  return requireRow(await queries.findMemberConfiguration(context, memberId));
}
