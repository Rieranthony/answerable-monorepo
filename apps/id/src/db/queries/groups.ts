import type { TenantReadContext } from "../../services/tenant-context.ts";
import type { PlatformWriteContext } from "../../services/platform-context.ts";
import {
  and,
  desc,
  eq,
  getTableColumns,
  sql,
  isNull,
  type SQL,
} from "drizzle-orm";
import type { PageQuery } from "../../http/pagination.ts";
import { beforeCursor, cursorPage, optionalEq, contains } from "./lists.ts";
import type { LifecycleStatus } from "../schema/vocabulary.ts";
import { isEffective } from "./effective.ts";
import { entitlementEvidence, softDeleteEntitlements } from "./entitlements.ts";
import { createId } from "../../lib/id.ts";
import type { Executor } from "../client.ts";
import {
  groupMembers,
  groups,
  members,
  users,
  entitlements,
} from "../schema/index.ts";

export type CreateGroupInput = {
  organizationId: string;
  slug: string;
  name: string;
};

export async function createGroup(
  context: PlatformWriteContext,
  input: CreateGroupInput,
) {
  const { tx: db } = context;
  const [group] = await db
    .insert(groups)
    .values({ id: createId(), ...input })
    .returning();

  return group!;
}

export type GroupQuery = PageQuery & { q?: string; status?: LifecycleStatus };
export type GroupPatch = { name?: string };
export type MemberWindow = {
  validFrom?: Date | null;
  validUntil?: Date | null;
};
const groupWhere = (organizationId: string, groupId: string) =>
  and(eq(groups.organizationId, organizationId), eq(groups.id, groupId));
const membershipWhere = (
  organizationId: string,
  groupId: string,
  memberId?: string,
) =>
  and(
    eq(groupMembers.organizationId, organizationId),
    eq(groupMembers.groupId, groupId),
    optionalEq(groupMembers.memberId, memberId),
  );
export async function listGroups(
  context: TenantReadContext<"directory">,
  query: GroupQuery,
) {
  const { tx: executor, organizationId } = context;
  return cursorPage(
    await executor
      .select()
      .from(groups)
      .where(
        and(
          isNull(groups.deletedAt),
          eq(groups.organizationId, organizationId),
          contains(query.q, groups.name, groups.slug),
          optionalEq(groups.status, query.status),
          beforeCursor(groups.id, query.cursor),
        ),
      )
      .orderBy(desc(groups.id))
      .limit(query.limit + 1),
    query.limit,
  );
}
function findGroupQuery(
  executor: Executor,
  organizationId: string,
  groupId: string,
) {
  return executor
    .select()
    .from(groups)
    .where(and(isNull(groups.deletedAt), groupWhere(organizationId, groupId)));
}
export async function findGroup(
  context: TenantReadContext<"directory">,
  groupId: string,
) {
  const { tx, organizationId } = context;
  const [row] = await findGroupQuery(tx, organizationId, groupId);
  return row ?? null;
}
export async function findGroupForCommand(
  context: PlatformWriteContext,
  organizationId: string,
  groupId: string,
) {
  const { tx } = context;
  const [row] = await findGroupQuery(tx, organizationId, groupId).for("update");
  await context.revalidate();
  return row ?? null;
}
export async function updateGroup(
  context: PlatformWriteContext,
  organizationId: string,
  groupId: string,
  patch: GroupPatch,
) {
  const { tx: executor } = context;
  const [row] = await executor
    .update(groups)
    .set(patch)
    .where(and(isNull(groups.deletedAt), groupWhere(organizationId, groupId)))
    .returning();
  return row ?? null;
}
export async function setGroupStatus(
  context: PlatformWriteContext,
  organizationId: string,
  groupId: string,
  status: LifecycleStatus,
) {
  const { tx: executor } = context;
  const [row] = await executor
    .update(groups)
    .set({ status })
    .where(and(isNull(groups.deletedAt), groupWhere(organizationId, groupId)))
    .returning();
  return row ?? null;
}
/** An assignment's policy fields and its member's user: the evidence its
 * audit events carry. */
const assignmentEvidence = {
  id: groupMembers.id,
  revision: groupMembers.revision,
  organizationId: groupMembers.organizationId,
  groupId: groupMembers.groupId,
  memberId: groupMembers.memberId,
  userId: sql<string>`(select ${members.userId} from ${members} where ${members.id} = ${groupMembers.memberId} and ${members.organizationId} = ${groupMembers.organizationId})`,
  validFrom: groupMembers.validFrom,
  validUntil: groupMembers.validUntil,
};

/** Soft-delete the live assignments `where` selects. The caller holds a write
 * context and the parent's lock; the rows, by id, are the actual effects. */
export async function softDeleteAssignments(executor: Executor, where: SQL) {
  const rows = await executor
    .update(groupMembers)
    .set({ deletedAt: sql`now()` })
    .where(and(isNull(groupMembers.deletedAt), where))
    .returning({ ...assignmentEvidence, deletedAt: groupMembers.deletedAt });
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

export async function readGroupPolicyForCommand(
  context: PlatformWriteContext,
  organizationId: string,
  groupId: string,
) {
  const { tx } = context;
  // The caller holds organisation/group locks; child locks also order global
  // user cascades through capture and the command's audit/receipt commit.
  const assignments = await tx
    .select(assignmentEvidence)
    .from(groupMembers)
    .where(
      and(
        isNull(groupMembers.deletedAt),
        membershipWhere(organizationId, groupId),
      ),
    )
    .orderBy(groupMembers.id)
    .for("share");
  const policy = await tx
    .select(entitlementEvidence)
    .from(entitlements)
    .where(
      and(
        isNull(entitlements.deletedAt),
        eq(entitlements.organizationId, organizationId),
        eq(entitlements.groupId, groupId),
      ),
    )
    .orderBy(entitlements.id)
    .for("share");
  await context.revalidate();
  return { assignments, entitlements: policy };
}

export async function deleteGroup(
  context: PlatformWriteContext,
  organizationId: string,
  groupId: string,
) {
  const { tx: executor } = context;
  // The service holds the parent group lock, preventing new child rows while
  // UPDATE RETURNING captures the actual effects, including ineligible policy.
  const softDeletedAssignments = await softDeleteAssignments(
    executor,
    membershipWhere(organizationId, groupId)!,
  );
  const softDeletedEntitlements = await softDeleteEntitlements(
    executor,
    and(
      eq(entitlements.organizationId, organizationId),
      eq(entitlements.groupId, groupId),
    )!,
  );
  const [row] = await executor
    .update(groups)
    .set({ deletedAt: sql`now()`, status: "disabled" })
    .where(and(isNull(groups.deletedAt), groupWhere(organizationId, groupId)))
    .returning();
  return {
    row: row!,
    effects: { softDeletedAssignments, softDeletedEntitlements },
  };
}
export async function listGroupMembers(
  context: TenantReadContext<"directory">,
  groupId: string,
  query: PageQuery,
) {
  const { tx: executor, organizationId } = context;
  return cursorPage(
    await executor
      .select({
        memberId: members.id,
        userId: users.id,
        email: users.email,
        name: users.name,
        validFrom: groupMembers.validFrom,
        validUntil: groupMembers.validUntil,
        effective: sql<boolean>`(${isEffective(groupMembers)})`,
      })
      .from(groupMembers)
      .innerJoin(members, eq(members.id, groupMembers.memberId))
      .innerJoin(users, eq(users.id, members.userId))
      .where(
        and(
          isNull(groupMembers.deletedAt),
          membershipWhere(organizationId, groupId),
          beforeCursor(groupMembers.memberId, query.cursor),
        ),
      )
      .orderBy(desc(groupMembers.memberId))
      .limit(query.limit + 1),
    query.limit,
    "memberId",
  );
}
function findGroupMemberQuery(
  executor: Executor,
  organizationId: string,
  groupId: string,
  memberId: string,
) {
  return executor
    .select()
    .from(groupMembers)
    .where(
      and(
        isNull(groupMembers.deletedAt),
        membershipWhere(organizationId, groupId, memberId),
      ),
    );
}
export async function findGroupMember(
  context: TenantReadContext<"directory">,
  groupId: string,
  memberId: string,
) {
  const { tx, organizationId } = context;
  const [row] = await findGroupMemberQuery(
    tx,
    organizationId,
    groupId,
    memberId,
  );
  return row ?? null;
}
export async function findGroupMemberForCommand(
  context: PlatformWriteContext,
  organizationId: string,
  groupId: string,
  memberId: string,
) {
  const { tx } = context;
  const [row] = await findGroupMemberQuery(
    tx,
    organizationId,
    groupId,
    memberId,
  ).for("update");
  await context.revalidate();
  return row ?? null;
}
export async function upsertGroupMember(
  context: PlatformWriteContext,
  input: {
    organizationId: string;
    groupId: string;
    memberId: string;
  } & MemberWindow,
) {
  const { tx: executor } = context;
  // xmax distinguishes insertion from the conflict update in the same statement.
  const [result] = await executor
    .insert(groupMembers)
    .values({ ...input, id: createId() })
    .onConflictDoUpdate({
      target: [groupMembers.groupId, groupMembers.memberId],
      targetWhere: isNull(groupMembers.deletedAt),
      set: {
        organizationId: input.organizationId,
        memberId: input.memberId,
        validFrom: input.validFrom,
        validUntil: input.validUntil,
      },
    })
    .returning({
      ...getTableColumns(groupMembers),
      created: sql<boolean>`xmax = 0`,
    });
  const { created, ...row } = result!;
  return { row, created };
}
export async function removeGroupMember(
  context: PlatformWriteContext,
  organizationId: string,
  groupId: string,
  memberId: string,
) {
  const { tx: executor } = context;
  const rows = await executor
    .update(groupMembers)
    .set({ deletedAt: sql`now()` })
    .where(
      and(
        isNull(groupMembers.deletedAt),
        membershipWhere(organizationId, groupId, memberId),
      ),
    )
    .returning();
  return rows[0] ?? null;
}
