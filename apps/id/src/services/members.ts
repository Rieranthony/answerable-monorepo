import { revokeMemberGrantContexts } from "../db/queries/grant-contexts.ts";
import { memberAccess } from "../db/queries/access.ts";
import * as queries from "../db/queries/members.ts";
import type { MemberWindow } from "../db/queries/groups.ts";
import {
  type TenantReadContext,
  type TenantMemberContext,
} from "./tenant-context.ts";
import { recordCommandEvent } from "./audit.ts";
import { found } from "../http/problem.ts";
import { assertRevision } from "../http/admin/revision.ts";
const notFound = "Organisation or member not found";
export async function listMembers(
  context: TenantReadContext<"directory">,
  query: queries.MemberQuery,
) {
  return queries.listMembers(context, query);
}
export async function getMember(
  context: TenantReadContext<"directory">,
  memberId: string,
) {
  return found(await queries.findMember(context, memberId), notFound);
}
export async function updateWindow(
  context: TenantMemberContext,
  memberId: string,
  patch: MemberWindow,
  expected?: { id: string; revision: number },
) {
  const { organizationId } = context;
  const before = found(
    await queries.findMemberConfiguration(context, memberId),
    notFound,
  );
  assertRevision(
    before,
    expected,
    "Member changed; read its configuration before issuing a new command",
  );
  const accessBefore = await memberAccess(context, memberId);
  const row = found(
    await queries.updateMemberWindow(context, memberId, patch),
    notFound,
  );
  const accessAfter = await memberAccess(context, memberId);
  await recordCommandEvent(context, {
    organizationId,
    targetType: "member",
    targetId: memberId,
    action: "member.updated",
    data: {
      changes: patch,
      before: { ...before, access: accessBefore },
      after: {
        ...before,
        revision: row.revision,
        validFrom: row.validFrom,
        validUntil: row.validUntil,
        access: accessAfter,
      },
    },
  });
  return { body: row, changed: row.revision !== before.revision };
}
export async function remove(context: TenantMemberContext, memberId: string) {
  const { organizationId } = context;
  const before = found(await queries.findMember(context, memberId), notFound);
  const accessBefore = await memberAccess(context, memberId);
  const row = found(await queries.revokeMember(context, memberId), notFound);
  const { removedGrants, softDeletedAssignments } =
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
    softDeletedAssignments.length === 0;
  await recordCommandEvent(context, {
    organizationId,
    targetType: "member",
    targetId: memberId,
    action: unchanged ? "member.removal_unchanged" : "member.removed",
    data: {
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
      effects: { removedGrants, softDeletedAssignments, revokedGrantContexts },
    },
  });
  return unchanged ? ("noop" as const) : ("applied" as const);
}

export async function reinstate(
  context: TenantMemberContext,
  memberId: string,
) {
  const { organizationId } = context;
  const before = found(await queries.findMember(context, memberId), notFound);
  const accessBefore = await memberAccess(context, memberId);
  const row = found(await queries.reinstateMember(context, memberId), notFound);
  const accessAfter = await memberAccess(context, memberId);
  await recordCommandEvent(context, {
    organizationId,
    targetType: "member",
    targetId: memberId,
    action:
      before.membershipStatus === "active"
        ? "member.reinstatement_unchanged"
        : "member.reinstated",
    data: {
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
  });
  return found(await queries.findMember(context, memberId), notFound);
}

export async function getMemberConfiguration(
  context: TenantMemberContext | TenantReadContext<"configuration">,
  memberId: string,
) {
  return found(
    await queries.findMemberConfiguration(context, memberId),
    notFound,
  );
}
