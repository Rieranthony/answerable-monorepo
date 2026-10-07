import { type PlatformWriteContext } from "./platform-context.ts";
import { type TenantReadContext } from "./tenant-context.ts";
import * as queries from "../db/queries/groups.ts";
import { findMemberForAssignment } from "../db/queries/members.ts";
import type { PageQuery } from "../http/pagination.ts";
import { lockOrganizationForCommand } from "../db/queries/organizations.ts";
import { recordCommandEvent, statusAction } from "./audit.ts";
import { found, ProblemError } from "../http/problem.ts";
const notFound = "Organisation or group not found";
function configuration(
  row: NonNullable<Awaited<ReturnType<typeof queries.findGroup>>>,
) {
  return {
    id: row.id,
    deletedAt: row.deletedAt,
    revision: row.revision,
    organizationId: row.organizationId,
    slug: row.slug,
    name: row.name,
    status: row.status,
  };
}
function assignment(
  row: NonNullable<Awaited<ReturnType<typeof queries.findGroupMember>>>,
) {
  return {
    id: row.id,
    deletedAt: row.deletedAt,
    revision: row.revision,
    organizationId: row.organizationId,
    groupId: row.groupId,
    memberId: row.memberId,
    validFrom: row.validFrom,
    validUntil: row.validUntil,
  };
}
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
export async function listGroups(
  context: TenantReadContext<"directory">,
  query: queries.GroupQuery,
) {
  return queries.listGroups(context, query);
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
      after: configuration(row),
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
  if (
    expected &&
    (before.id !== expected.id || before.revision !== expected.revision)
  )
    throw new ProblemError(
      412,
      "revision_mismatch",
      "Group changed; read its current revision before issuing a new command",
    );
  const changed = Object.entries(patch).some(
    ([key, value]) =>
      value !== undefined && before[key as keyof queries.GroupPatch] !== value,
  );
  const row = changed
    ? (await queries.updateGroup(context, organizationId, groupId, patch))!
    : before;
  await recordCommandEvent(context, {
    organizationId,
    targetType: "group",
    targetId: groupId,
    action: changed ? "group.updated" : "group.update_unchanged",
    data: { before: configuration(before), after: configuration(row) },
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
  const changed = existing.status !== status;
  const policySources = changed
    ? await queries.readGroupPolicyForCommand(context, organizationId, groupId)
    : undefined;
  const row = changed
    ? (await queries.setGroupStatus(context, organizationId, groupId, status))!
    : existing;
  await recordCommandEvent(context, {
    organizationId,
    targetType: "group",
    targetId: groupId,
    action: statusAction("group", status, changed),
    data: {
      before: configuration(existing),
      after: configuration(row),
      ...(changed ? { policySources } : {}),
    },
  });
  return { row, changed };
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
      before: configuration(before),
      after: configuration(row),
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
  if (
    expected !== undefined &&
    (expected === null
      ? before !== null
      : !before ||
        before.id !== expected.id ||
        before.revision !== expected.revision)
  )
    throw new ProblemError(
      412,
      "revision_mismatch",
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
  await recordCommandEvent(context, {
    organizationId,
    targetType: "group_member",
    targetId: memberId,
    action: !changed
      ? "group_member.update_unchanged"
      : result.created
        ? "group_member.added"
        : "group_member.updated",
    data: {
      groupId,
      before: before ? assignment(before) : null,
      after: assignment(result.row),
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
      before: assignment(before),
      after: assignment(row!),
      deletionMode: "soft",
    },
  });
}
