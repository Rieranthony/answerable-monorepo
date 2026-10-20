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
    "Member changed; read it again before issuing a new command",
  );
  const accessBefore = await memberAccess(context, memberId);
  const row = found(
    await queries.updateMemberWindow(context, memberId, patch),
    notFound,
  );
  const changed = row.revision !== before.revision;
  // An unchanged command's receipt is its record; it writes no audit event.
  if (changed)
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
          access: await memberAccess(context, memberId),
        },
      },
    });
  return { row, changed };
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
  const unchanged =
    revokedGrantContexts.length === 0 &&
    before.membershipStatus === "revoked" &&
    removedGrants.length === 0 &&
    softDeletedAssignments.length === 0;
  if (unchanged) return "noop" as const;
  const accessAfter = await memberAccess(context, memberId);
  await recordCommandEvent(context, {
    organizationId,
    targetType: "member",
    targetId: memberId,
    action: "member.removed",
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
  return "applied" as const;
}

export async function reinstate(
  context: TenantMemberContext,
  memberId: string,
) {
  const { organizationId } = context;
  const before = found(await queries.findMember(context, memberId), notFound);
  const accessBefore = await memberAccess(context, memberId);
  const row = found(await queries.reinstateMember(context, memberId), notFound);
  const changed = before.membershipStatus !== "active";
  if (changed)
    await recordCommandEvent(context, {
      organizationId,
      targetType: "member",
      targetId: memberId,
      action: "member.reinstated",
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
          access: await memberAccess(context, memberId),
        },
      },
    });
  return {
    row: found(await queries.findMember(context, memberId), notFound),
    changed,
  };
}
