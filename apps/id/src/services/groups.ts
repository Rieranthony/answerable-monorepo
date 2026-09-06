import * as queries from "../db/queries/groups.ts";
import { findMember } from "../db/queries/members.ts";
import type { PageQuery } from "../http/pagination.ts";
import type { Database, Executor } from "../db/client.ts";
import {
  findOrganization,
  lockOrganization,
} from "../db/queries/organizations.ts";
import { recordAuditEvent } from "../db/queries/audit.ts";
import { cursorPage } from "../http/pagination.ts";
import { ProblemError } from "../http/problem.ts";
import type { Actor } from "./actor.ts";
function requireRow<T>(row: T | null): T {
  if (!row)
    throw new ProblemError(404, "not_found", "Organisation or group not found");
  return row;
}
function audit(
  tx: Executor,
  actor: Actor,
  organizationId: string,
  targetId: string,
  action: string,
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
  tx: Executor,
  organizationId: string,
  groupId: string,
) {
  requireRow(await lockOrganization(tx, organizationId));
  return requireRow(await queries.findGroup(tx, organizationId, groupId));
}
export async function listGroups(
  db: Database,
  organizationId: string,
  query: queries.GroupQuery,
) {
  requireRow(await findOrganization(db, organizationId));
  return cursorPage(
    await queries.listGroups(db, organizationId, query),
    query.limit,
  );
}
export async function getGroup(
  db: Database,
  organizationId: string,
  groupId: string,
) {
  return requireRow(await queries.findGroup(db, organizationId, groupId));
}
export function createGroup(
  db: Database,
  actor: Actor,
  organizationId: string,
  input: Omit<queries.CreateGroupInput, "organizationId">,
) {
  return db.transaction(async (tx) => {
    requireRow(await lockOrganization(tx, organizationId));
    const row = await queries.createGroup(tx, { ...input, organizationId });
    await audit(tx, actor, organizationId, row.id, "group.created", {
      ...input,
    });
    return row;
  });
}
export function updateGroup(
  db: Database,
  actor: Actor,
  organizationId: string,
  groupId: string,
  patch: queries.GroupPatch,
) {
  return db.transaction(async (tx) => {
    await lockedGroup(tx, organizationId, groupId);
    const row = await queries.updateGroup(tx, organizationId, groupId, patch);
    await audit(tx, actor, organizationId, groupId, "group.updated", {
      changes: patch,
    });
    return row!;
  });
}
function setStatus(
  db: Database,
  actor: Actor,
  organizationId: string,
  groupId: string,
  status: "active" | "disabled",
) {
  return db.transaction(async (tx) => {
    const existing = await lockedGroup(tx, organizationId, groupId);
    if (existing.status === status)
      throw new ProblemError(
        409,
        `group_already_${status}`,
        `Group is already ${status}`,
      );
    const row = await queries.setGroupStatus(
      tx,
      organizationId,
      groupId,
      status,
    );
    await audit(
      tx,
      actor,
      organizationId,
      groupId,
      status === "active" ? "group.enabled" : "group.disabled",
      { status },
    );
    return row!;
  });
}
export function disableGroup(
  db: Database,
  actor: Actor,
  organizationId: string,
  groupId: string,
) {
  return setStatus(db, actor, organizationId, groupId, "disabled");
}
export function enableGroup(
  db: Database,
  actor: Actor,
  organizationId: string,
  groupId: string,
) {
  return setStatus(db, actor, organizationId, groupId, "active");
}
export function eraseGroup(
  db: Database,
  actor: Actor,
  organizationId: string,
  groupId: string,
  confirm: string,
) {
  return db.transaction(async (tx) => {
    await lockedGroup(tx, organizationId, groupId);
    if (confirm !== groupId)
      throw new ProblemError(
        400,
        "confirmation_mismatch",
        "Confirmation must match the group ID",
      );
    await queries.deleteGroup(tx, organizationId, groupId);
    await audit(tx, actor, organizationId, groupId, "group.erased", {});
  });
}
export async function listGroupMembers(
  db: Database,
  organizationId: string,
  groupId: string,
  query: PageQuery,
) {
  await getGroup(db, organizationId, groupId);
  const rows = await queries.listGroupMembers(
    db,
    organizationId,
    groupId,
    query,
  );
  const items = rows.slice(0, query.limit);
  return {
    items,
    nextCursor:
      rows.length > query.limit ? items[items.length - 1].memberId : null,
  };
}
function requireManual(group: Awaited<ReturnType<typeof getGroup>>) {
  if (group.externalId !== null)
    throw new ProblemError(
      409,
      "group_directory_managed",
      "Directory group membership cannot be edited by hand",
    );
}
export function putMember(
  db: Database,
  actor: Actor,
  organizationId: string,
  groupId: string,
  memberId: string,
  window: queries.MemberWindow,
) {
  return db.transaction(async (tx) => {
    const group = await lockedGroup(tx, organizationId, groupId);
    requireRow(await findMember(tx, organizationId, memberId));
    requireManual(group);
    const result = await queries.upsertGroupMember(tx, {
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
      result.created ? "group_member.added" : "group_member.updated",
      { groupId },
      "group_member",
    );
    return result;
  });
}
export function removeMember(
  db: Database,
  actor: Actor,
  organizationId: string,
  groupId: string,
  memberId: string,
) {
  return db.transaction(async (tx) => {
    requireManual(await lockedGroup(tx, organizationId, groupId));
    requireRow(
      await queries.findGroupMember(tx, organizationId, groupId, memberId),
    );
    await queries.removeGroupMember(tx, organizationId, groupId, memberId);
    await audit(
      tx,
      actor,
      organizationId,
      memberId,
      "group_member.removed",
      { groupId },
      "group_member",
    );
  });
}
