import { and, desc, eq, ilike, or, sql, getTableColumns } from "drizzle-orm";
import { beforeCursor, type PageQuery } from "../../http/pagination.ts";
import type { LifecycleStatus } from "../schema/vocabulary.ts";
import { isEffective } from "./effective.ts";
import { createId } from "../../lib/id.ts";
import type { Executor } from "../client.ts";
import { groupMembers, groups, members, users } from "../schema/index.ts";

export type CreateGroupInput = {
  organizationId: string;
  slug: string;
  name: string;
  /** Set when the group mirrors an upstream directory group. */
  externalId?: string;
};

export async function createGroup(db: Executor, input: CreateGroupInput) {
  const [group] = await db
    .insert(groups)
    .values({ id: createId(), ...input })
    .returning();

  return group!;
}

export async function addGroupMember(
  db: Executor,
  input: { organizationId: string; groupId: string; memberId: string },
) {
  const [membership] = await db.insert(groupMembers).values(input).returning();

  return membership!;
}

export type GroupQuery = PageQuery & { q?: string; status?: LifecycleStatus };
export type GroupPatch = { name?: string; externalId?: string | null };
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
    memberId === undefined ? undefined : eq(groupMembers.memberId, memberId),
  );
export function listGroups(
  executor: Executor,
  organizationId: string,
  query: GroupQuery,
) {
  return executor
    .select()
    .from(groups)
    .where(
      and(
        eq(groups.organizationId, organizationId),
        query.q === undefined
          ? undefined
          : or(
              ilike(groups.name, `%${query.q}%`),
              ilike(groups.slug, `%${query.q}%`),
            ),
        query.status === undefined
          ? undefined
          : eq(groups.status, query.status),
        beforeCursor(groups.id, query.cursor),
      ),
    )
    .orderBy(desc(groups.id))
    .limit(query.limit + 1);
}
export async function findGroup(
  executor: Executor,
  organizationId: string,
  groupId: string,
) {
  const [row] = await executor
    .select()
    .from(groups)
    .where(groupWhere(organizationId, groupId));
  return row ?? null;
}
export async function updateGroup(
  executor: Executor,
  organizationId: string,
  groupId: string,
  patch: GroupPatch,
) {
  const [row] = await executor
    .update(groups)
    .set(patch)
    .where(groupWhere(organizationId, groupId))
    .returning();
  return row ?? null;
}
export async function setGroupStatus(
  executor: Executor,
  organizationId: string,
  groupId: string,
  status: LifecycleStatus,
) {
  const [row] = await executor
    .update(groups)
    .set({ status })
    .where(groupWhere(organizationId, groupId))
    .returning();
  return row ?? null;
}
export async function deleteGroup(
  executor: Executor,
  organizationId: string,
  groupId: string,
) {
  await executor.delete(groups).where(groupWhere(organizationId, groupId));
}
export function listGroupMembers(
  executor: Executor,
  organizationId: string,
  groupId: string,
  query: PageQuery,
) {
  return executor
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
        membershipWhere(organizationId, groupId),
        beforeCursor(groupMembers.memberId, query.cursor),
      ),
    )
    .orderBy(desc(groupMembers.memberId))
    .limit(query.limit + 1);
}
export async function findGroupMember(
  executor: Executor,
  organizationId: string,
  groupId: string,
  memberId: string,
) {
  const [row] = await executor
    .select()
    .from(groupMembers)
    .where(membershipWhere(organizationId, groupId, memberId));
  return row ?? null;
}
export async function upsertGroupMember(
  executor: Executor,
  input: {
    organizationId: string;
    groupId: string;
    memberId: string;
  } & MemberWindow,
) {
  // xmax distinguishes insertion from the conflict update in the same statement.
  const [result] = await executor
    .insert(groupMembers)
    .values(input)
    .onConflictDoUpdate({
      target: [groupMembers.groupId, groupMembers.memberId],
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
  executor: Executor,
  organizationId: string,
  groupId: string,
  memberId: string,
) {
  const rows = await executor
    .delete(groupMembers)
    .where(membershipWhere(organizationId, groupId, memberId))
    .returning();
  return rows.length > 0;
}
