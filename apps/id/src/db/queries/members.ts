import { and, desc, eq, ilike, not, or, sql } from "drizzle-orm";
import {
  requireTenantDirectoryContext,
  requireTenantMemberAccessContext,
  requireTenantMemberConfigurationContext,
  requireTenantMemberContext,
  type TenantMemberContext,
  type TenantReadContext,
} from "../../services/tenant-context.ts";
import {
  requirePlatformWriteContext,
  type PlatformWriteContext,
} from "../../services/platform-context.ts";
import {
  members,
  users,
  groups,
  groupMembers,
  entitlements,
} from "../schema/index.ts";
import { beforeCursor, type PageQuery } from "../../http/pagination.ts";
import { isEffective } from "./effective.ts";
import type { MemberWindow } from "./groups.ts";
export type MemberQuery = PageQuery & {
  q?: string;
  email?: string;
  effective?: boolean;
};
const selection = {
  id: members.id,
  revision: members.revision,
  organizationId: members.organizationId,
  userId: users.id,
  email: users.email,
  name: users.name,
  status: users.status,
  membershipStatus: members.status,
  revokedAt: members.revokedAt,
  validFrom: members.validFrom,
  validUntil: members.validUntil,
  createdAt: members.createdAt,
  effective: sql<boolean>`(${isEffective(members)})`,
};
const memberWhere = (organizationId: string, memberId: string) =>
  and(eq(members.organizationId, organizationId), eq(members.id, memberId));
export function listMembers(
  context: TenantReadContext<"directory"> | TenantReadContext<"memberAccess">,
  query: MemberQuery,
) {
  const { tx: executor, organizationId } =
    context.access === "memberAccess"
      ? requireTenantMemberAccessContext(context)
      : requireTenantDirectoryContext(context);
  return executor
    .select(selection)
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(
      and(
        eq(members.organizationId, organizationId),
        query.email === undefined
          ? undefined
          : eq(users.email, query.email.toLowerCase()),
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
  context: TenantReadContext<"directory"> | TenantMemberContext,
  memberId: string,
) {
  const { tx: executor, organizationId } =
    context.access === "command"
      ? requireTenantMemberContext(context)
      : requireTenantDirectoryContext(context);
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
  context: TenantMemberContext,
  memberId: string,
  patch: MemberWindow,
) {
  const { tx: executor, organizationId } = requireTenantMemberContext(context);
  const [row] = await executor
    .update(members)
    .set(patch)
    .where(memberWhere(organizationId, memberId))
    .returning({ id: members.id });
  return row ? findMember(context, memberId) : null;
}
export async function revokeMember(
  context: TenantMemberContext,
  memberId: string,
) {
  const { tx: executor, organizationId } = requireTenantMemberContext(context);
  const [row] = await executor
    .update(members)
    .set({
      status: "revoked",
      revokedAt: sql`coalesce(${members.revokedAt}, now())`,
    })
    .where(memberWhere(organizationId, memberId))
    .returning();
  return row ?? null;
}

export async function reinstateMember(
  context: TenantMemberContext,
  memberId: string,
) {
  const { tx: executor, organizationId } = requireTenantMemberContext(context);
  const [row] = await executor
    .update(members)
    .set({ status: "active", revokedAt: null })
    .where(memberWhere(organizationId, memberId))
    .returning();
  return row ?? null;
}

/** Return the actual removed rows for transactional offboarding evidence. */
export async function removeMemberAssignments(
  context: TenantMemberContext,
  memberId: string,
) {
  const { tx: executor, organizationId } = requireTenantMemberContext(context);
  const removedGrants = await executor
    .delete(entitlements)
    .where(
      and(
        eq(entitlements.organizationId, organizationId),
        eq(entitlements.memberId, memberId),
      ),
    )
    .returning();
  const removedGroups = await executor
    .delete(groupMembers)
    .where(
      and(
        eq(groupMembers.organizationId, organizationId),
        eq(groupMembers.memberId, memberId),
      ),
    )
    .returning();
  return { removedGrants, removedGroups };
}

/** Stable membership configuration; excludes user/group projections and clock-derived access. */
export async function findMemberConfiguration(
  context:
    | TenantReadContext<"configuration">
    | TenantReadContext<"memberAccess">
    | TenantMemberContext,
  memberId: string,
) {
  const { tx: executor, organizationId } =
    context.access === "memberAccess"
      ? requireTenantMemberAccessContext(context)
      : requireTenantMemberConfigurationContext(context);
  const query = executor
    .select({
      id: members.id,
      revision: members.revision,
      organizationId: members.organizationId,
      userId: members.userId,
      membershipStatus: members.status,
      revokedAt: members.revokedAt,
      validFrom: members.validFrom,
      validUntil: members.validUntil,
    })
    .from(members)
    .where(memberWhere(organizationId, memberId));
  const [row] = await (context.access === "command"
    ? query.for("update")
    : query);
  return row ?? null;
}

/** Assignment checks need membership state, not personal data or group projections. */
export async function findMemberForAssignment(
  context: PlatformWriteContext,
  organizationId: string,
  memberId: string,
) {
  const { tx } = requirePlatformWriteContext(context);
  const [row] = await tx
    .select({ membershipStatus: members.status })
    .from(members)
    .where(memberWhere(organizationId, memberId));
  return row ?? null;
}
