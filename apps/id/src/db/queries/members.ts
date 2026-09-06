import { and, desc, eq, ilike, not, or, sql } from "drizzle-orm";
import type { Executor } from "../client.ts";
import { members, users, groups, groupMembers } from "../schema/index.ts";
import { beforeCursor, type PageQuery } from "../../http/pagination.ts";
import { isEffective } from "./effective.ts";
import type { MemberWindow } from "./groups.ts";
export type MemberQuery = PageQuery & { q?: string; effective?: boolean };
const selection = {
  id: members.id,
  organizationId: members.organizationId,
  userId: users.id,
  email: users.email,
  name: users.name,
  status: users.status,
  validFrom: members.validFrom,
  validUntil: members.validUntil,
  createdAt: members.createdAt,
  effective: sql<boolean>`(${isEffective(members)})`,
};
const memberWhere = (organizationId: string, memberId: string) =>
  and(eq(members.organizationId, organizationId), eq(members.id, memberId));
export function listMembers(
  executor: Executor,
  organizationId: string,
  query: MemberQuery,
) {
  return executor
    .select(selection)
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(
      and(
        eq(members.organizationId, organizationId),
        query.q === undefined
          ? undefined
          : or(
              ilike(users.email, `%${query.q}%`),
              ilike(users.name, `%${query.q}%`),
            ),
        query.effective === undefined
          ? undefined
          : query.effective
            ? isEffective(members)
            : not(isEffective(members)),
        beforeCursor(members.id, query.cursor),
      ),
    )
    .orderBy(desc(members.id))
    .limit(query.limit + 1);
}
export async function findMember(
  executor: Executor,
  organizationId: string,
  memberId: string,
) {
  const [row] = await executor
    .select(selection)
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(memberWhere(organizationId, memberId));
  if (!row) return null;
  const memberships = await executor
    .select({
      groupId: groups.id,
      slug: groups.slug,
      name: groups.name,
      validFrom: groupMembers.validFrom,
      validUntil: groupMembers.validUntil,
    })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(
      and(
        eq(groupMembers.organizationId, organizationId),
        eq(groupMembers.memberId, memberId),
      ),
    )
    .orderBy(desc(groups.id));
  return { ...row, groups: memberships };
}
export async function updateMemberWindow(
  executor: Executor,
  organizationId: string,
  memberId: string,
  patch: MemberWindow,
) {
  const [row] = await executor
    .update(members)
    .set(patch)
    .where(memberWhere(organizationId, memberId))
    .returning({ id: members.id });
  return row ? findMember(executor, organizationId, memberId) : null;
}
export async function removeMember(
  executor: Executor,
  organizationId: string,
  memberId: string,
) {
  const [row] = await executor
    .delete(members)
    .where(memberWhere(organizationId, memberId))
    .returning();
  return row ?? null;
}
