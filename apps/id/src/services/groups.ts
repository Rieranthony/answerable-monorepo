import { type PlatformWriteContext } from "./platform-context.ts";
import { type TenantReadContext } from "./tenant-context.ts";
import * as queries from "../db/queries/groups.ts";
import { findMemberForAssignment } from "../db/queries/members.ts";
import type { PageQuery } from "../http/pagination.ts";
import { lockOrganizationForCommand } from "../db/queries/organizations.ts";
import { recordCommandEvent, statusAction, evidence } from "./audit.ts";
import { found, ProblemError } from "../http/problem.ts";
import { assertRevision } from "../http/admin/revision.ts";
const notFound = "Organisation or group not found";
async function lockedGroup(
  context: PlatformWriteContext,
  organizationId: string,
  groupId: string,
) {
  found(await lockOrganizationForCommand(context, organizationId), notFound);
  return found(
    await queries.findGroupForCommand(context, organizationId, groupId),
    notFound,
  );
}
export async function getGroup(
  context: TenantReadContext<"directory">,
  groupId: string,
) {
  return found(await queries.findGroup(context, groupId), notFound);
}
export async function createGroup(
  context: PlatformWriteContext,
  organizationId: string,
  input: Omit<queries.CreateGroupInput, "organizationId">,
) {
  found(await lockOrganizationForCommand(context, organizationId), notFound);
  const row = await queries.createGroup(context, { ...input, organizationId });
  await recordCommandEvent(context, {
    organizationId,
    targetType: "group",
    targetId: row.id,
    action: "group.created",
    data: {
      before: null,
      after: evidence(row),
    },
  });
  return row;
}
export async function updateGroup(
  context: PlatformWriteContext,
  organizationId: string,
  groupId: string,
  patch: queries.GroupPatch,
  expected?: { id: string; revision: number },
) {
  const before = await lockedGroup(context, organizationId, groupId);
  assertRevision(
    before,
    expected,
    "Group changed; read its current revision before issuing a new command",
  );
  const changed = Object.entries(patch).some(
    ([key, value]) =>
      value !== undefined && before[key as keyof queries.GroupPatch] !== value,
  );
  const row = changed
    ? (await queries.updateGroup(context, organizationId, groupId, patch))!
    : before;
  // An unchanged command's receipt is its record; it writes no audit event.
  if (changed)
    await recordCommandEvent(context, {
      organizationId,
      targetType: "group",
      targetId: groupId,
      action: "group.updated",
      data: { before: evidence(before), after: evidence(row) },
    });
  return { row, changed };
}
async function setStatus(
  context: PlatformWriteContext,
  organizationId: string,
  groupId: string,
  status: "active" | "disabled",
) {
  const existing = await lockedGroup(context, organizationId, groupId);
  if (existing.status === status) return { row: existing, changed: false };
  const policySources = await queries.readGroupPolicyForCommand(
    context,
    organizationId,
    groupId,
  );
  const row = (await queries.setGroupStatus(
    context,
    organizationId,
    groupId,
    status,
  ))!;
  await recordCommandEvent(context, {
    organizationId,
    targetType: "group",
    targetId: groupId,
    action: statusAction("group", status),
    data: {
      before: evidence(existing),
      after: evidence(row),
      policySources,
    },
  });
  return { row, changed: true };
}
export async function disableGroup(
  context: PlatformWriteContext,
  organizationId: string,
  groupId: string,
) {
  return setStatus(context, organizationId, groupId, "disabled");
}
export async function enableGroup(
  context: PlatformWriteContext,
  organizationId: string,
  groupId: string,
) {
  return setStatus(context, organizationId, groupId, "active");
}
export async function eraseGroup(
  context: PlatformWriteContext,
  organizationId: string,
  groupId: string,
  confirm: string,
) {
  const before = await lockedGroup(context, organizationId, groupId);
  if (confirm !== groupId)
    throw new ProblemError(
      400,
      "confirmation_mismatch",
      "Confirmation must match the group ID",
    );
  const { row, effects } = await queries.deleteGroup(
    context,
    organizationId,
    groupId,
  );
  await recordCommandEvent(context, {
    organizationId,
    targetType: "group",
    targetId: groupId,
    action: "group.erased",
    data: {
      before: evidence(before),
      after: evidence(row),
      deletionMode: "soft",
      effects,
    },
  });
}
export async function listGroupMembers(
  context: TenantReadContext<"directory">,
  groupId: string,
  query: PageQuery,
) {
  await getGroup(context, groupId);
  return queries.listGroupMembers(context, groupId, query);
}
export async function getGroupMember(
  context: TenantReadContext<"directory">,
  groupId: string,
  memberId: string,
) {
  return found(
    await queries.findGroupMember(context, groupId, memberId),
    notFound,
  );
}
export async function putMember(
  context: PlatformWriteContext,
  organizationId: string,
  groupId: string,
  memberId: string,
  window: queries.MemberWindow,
  expected?: { id: string; revision: number } | null,
) {
  await lockedGroup(context, organizationId, groupId);
  const member = found(
    await findMemberForAssignment(context, organizationId, memberId),
    notFound,
  );
  if (member.membershipStatus === "revoked")
    throw new ProblemError(
      409,
      "membership_revoked",
      "Reinstate the membership before assigning access",
    );
  const before = await queries.findGroupMemberForCommand(
    context,
    organizationId,
    groupId,
    memberId,
  );
  assertRevision(
    before,
    expected,
    "Assignment changed; read its current state before issuing a new command",
  );
  const changed =
    !before ||
    (window.validFrom !== undefined &&
      window.validFrom?.getTime() !== before.validFrom?.getTime()) ||
    (window.validUntil !== undefined &&
      window.validUntil?.getTime() !== before.validUntil?.getTime());
  const result =
    !changed && before
      ? { row: before, created: false }
      : await queries.upsertGroupMember(context, {
          organizationId,
          groupId,
          memberId,
          ...window,
        });
  if (changed)
    await recordCommandEvent(context, {
      organizationId,
      targetType: "group_member",
      targetId: memberId,
      action: result.created ? "group_member.added" : "group_member.updated",
      data: {
        groupId,
        before: before ? evidence(before) : null,
        after: evidence(result.row),
      },
    });
  return { ...result, changed };
}
export async function removeMember(
  context: PlatformWriteContext,
  organizationId: string,
  groupId: string,
  memberId: string,
) {
  await lockedGroup(context, organizationId, groupId);
  const before = found(
    await queries.findGroupMemberForCommand(
      context,
      organizationId,
      groupId,
      memberId,
    ),
    notFound,
  );
  const row = await queries.removeGroupMember(
    context,
    organizationId,
    groupId,
    memberId,
  );
  await recordCommandEvent(context, {
    organizationId,
    targetType: "group_member",
    targetId: memberId,
    action: "group_member.removed",
    data: {
      groupId,
      before: evidence(before),
      after: evidence(row!),
      deletionMode: "soft",
    },
  });
}
