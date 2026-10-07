import {
  requirePlatformWriteContext,
  type PlatformWriteContext,
} from "./platform-context.ts";
import { type TenantReadContext } from "./tenant-context.ts";
import * as queries from "../db/queries/groups.ts";
import { findMemberForAssignment } from "../db/queries/members.ts";
import type { PageQuery } from "../http/pagination.ts";
import type { Executor } from "../db/client.ts";
import { lockOrganizationForCommand } from "../db/queries/organizations.ts";
import { recordAuditEvent, type AuditAction } from "../db/queries/audit.ts";
import { ProblemError } from "../http/problem.ts";
import type { Actor } from "./actor.ts";
function requireRow<T>(row: T | null): T {
  if (!row)
    throw new ProblemError(404, "not_found", "Organisation or group not found");
  return row;
}
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
function audit(
  tx: Executor,
  actor: Actor,
  organizationId: string,
  targetId: string,
  action: AuditAction,
  data: Record<string, unknown>,
  targetType = "group",
) {
  return recordAuditEvent(tx, {
    ...actor,
    organizationId,
    targetId,
    targetType,
    action,
    data,
    outcome: "success",
  });
}
async function lockedGroup(
  context: PlatformWriteContext,
  organizationId: string,
  groupId: string,
) {
  requireRow(await lockOrganizationForCommand(context, organizationId));
  return requireRow(
    await queries.findGroupForCommand(context, organizationId, groupId),
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
  return requireRow(await queries.findGroup(context, groupId));
}
export async function createGroup(
  context: PlatformWriteContext,
  organizationId: string,
  input: Omit<queries.CreateGroupInput, "organizationId">,
) {
  const { tx, actor } = requirePlatformWriteContext(context);
  requireRow(await lockOrganizationForCommand(context, organizationId));
  const row = await queries.createGroup(context, { ...input, organizationId });
  await audit(tx, actor, organizationId, row.id, "group.created", {
    before: null,
    after: configuration(row),
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
  const { tx, actor } = requirePlatformWriteContext(context);
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
  await audit(
    tx,
    actor,
    organizationId,
    groupId,
    changed ? "group.updated" : "group.update_unchanged",
    { before: configuration(before), after: configuration(row) },
  );
  return { row, changed };
}
async function setStatus(
  context: PlatformWriteContext,
  organizationId: string,
  groupId: string,
  status: "active" | "disabled",
) {
  const { tx, actor } = requirePlatformWriteContext(context);
  const existing = await lockedGroup(context, organizationId, groupId);
  const changed = existing.status !== status;
  const policySources = changed
    ? await queries.readGroupPolicyForCommand(context, organizationId, groupId)
    : undefined;
  const row = changed
    ? (await queries.setGroupStatus(context, organizationId, groupId, status))!
    : existing;
  await audit(
    tx,
    actor,
    organizationId,
    groupId,
    changed
      ? status === "active"
        ? "group.enabled"
        : "group.disabled"
      : status === "active"
        ? "group.enable_unchanged"
        : "group.disable_unchanged",
    {
      before: configuration(existing),
      after: configuration(row),
      ...(changed ? { policySources } : {}),
    },
  );
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
  const { tx, actor } = requirePlatformWriteContext(context);
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
  await audit(tx, actor, organizationId, groupId, "group.erased", {
    before: configuration(before),
    after: configuration(row),
    deletionMode: "soft",
    effects,
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
  return requireRow(await queries.findGroupMember(context, groupId, memberId));
}
export async function putMember(
  context: PlatformWriteContext,
  organizationId: string,
  groupId: string,
  memberId: string,
  window: queries.MemberWindow,
  expected?: { id: string; revision: number } | null,
) {
  const { tx, actor } = requirePlatformWriteContext(context);
  await lockedGroup(context, organizationId, groupId);
  const member = requireRow(
    await findMemberForAssignment(context, organizationId, memberId),
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
  await audit(
    tx,
    actor,
    organizationId,
    memberId,
    !changed
      ? "group_member.update_unchanged"
      : result.created
        ? "group_member.added"
        : "group_member.updated",
    {
      groupId,
      before: before ? assignment(before) : null,
      after: assignment(result.row),
    },
    "group_member",
  );
  return { ...result, changed };
}
export async function removeMember(
  context: PlatformWriteContext,
  organizationId: string,
  groupId: string,
  memberId: string,
) {
  const { tx, actor } = requirePlatformWriteContext(context);
  await lockedGroup(context, organizationId, groupId);
  const before = requireRow(
    await queries.findGroupMemberForCommand(
      context,
      organizationId,
      groupId,
      memberId,
    ),
  );
  const row = await queries.removeGroupMember(
    context,
    organizationId,
    groupId,
    memberId,
  );
  await audit(
    tx,
    actor,
    organizationId,
    memberId,
    "group_member.removed",
    {
      groupId,
      before: assignment(before),
      after: assignment(row!),
      deletionMode: "soft",
    },
    "group_member",
  );
}
