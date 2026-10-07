import { and, desc, eq, not, sql, isNull } from "drizzle-orm";
import type {
  TenantMemberContext,
  TenantReadContext,
} from "../../services/tenant-context.ts";
import type { PlatformWriteContext } from "../../services/platform-context.ts";
import {
  members,
  users,
  groups,
  groupMembers,
  entitlements,
} from "../schema/index.ts";
import type { PageQuery } from "../../http/pagination.ts";
import { beforeCursor, contains, cursorPage, optionalEq } from "./lists.ts";
import { isEffective } from "./effective.ts";
import { softDeleteEntitlements } from "./entitlements.ts";
import { softDeleteAssignments, type MemberWindow } from "./groups.ts";
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
/** A membership's state and window: the evidence erasure events carry. */
export const memberEvidence = {
  id: members.id,
  organizationId: members.organizationId,
  userId: members.userId,
  revision: members.revision,
  status: members.status,
  revokedAt: members.revokedAt,
  validFrom: members.validFrom,
  validUntil: members.validUntil,
};
const memberWhere = (organizationId: string, memberId: string) =>
  and(eq(members.organizationId, organizationId), eq(members.id, memberId));
export async function listMembers(
  context: TenantReadContext<"directory"> | TenantReadContext<"memberAccess">,
  query: MemberQuery,
) {
  const { tx: executor, organizationId } = context;
  return cursorPage(
    await executor
      .select(selection)
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .where(
        and(
          isNull(members.deletedAt),
          eq(members.organizationId, organizationId),
          optionalEq(users.email, query.email?.toLowerCase()),
          contains(query.q, users.email, users.name),
          query.effective === undefined
            ? undefined
            : query.effective
              ? isEffective(members)
              : not(isEffective(members)),
          beforeCursor(members.id, query.cursor),
        ),
      )
      .orderBy(desc(members.id))
      .limit(query.limit + 1),
    query.limit,
  );
}
export async function findMember(
  context: TenantReadContext<"directory"> | TenantMemberContext,
  memberId: string,
) {
  const { tx: executor, organizationId } = context;
  const [row] = await executor
    .select(selection)
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(
      and(isNull(members.deletedAt), memberWhere(organizationId, memberId)),
    );
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
        isNull(groupMembers.deletedAt),
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
  const { tx: executor, organizationId } = context;
  const [row] = await executor
    .update(members)
    .set(patch)
    .where(
      and(isNull(members.deletedAt), memberWhere(organizationId, memberId)),
    )
    .returning({ id: members.id });
  return row ? findMember(context, memberId) : null;
}
export async function revokeMember(
  context: TenantMemberContext,
  memberId: string,
) {
  const { tx: executor, organizationId } = context;
  const [row] = await executor
    .update(members)
    .set({
      status: "revoked",
      revokedAt: sql`coalesce(${members.revokedAt}, now())`,
    })
    .where(
      and(isNull(members.deletedAt), memberWhere(organizationId, memberId)),
    )
    .returning();
  return row ?? null;
}

export async function reinstateMember(
  context: TenantMemberContext,
  memberId: string,
) {
  const { tx: executor, organizationId } = context;
  const [row] = await executor
    .update(members)
    .set({ status: "active", revokedAt: null })
    .where(
      and(isNull(members.deletedAt), memberWhere(organizationId, memberId)),
    )
    .returning();
  return row ?? null;
}

/** Return the actual removed rows for transactional offboarding evidence. */
export async function removeMemberAssignments(
  context: TenantMemberContext,
  memberId: string,
) {
  const { tx: executor, organizationId } = context;
  const removedGrants = await softDeleteEntitlements(
    executor,
    and(
      eq(entitlements.organizationId, organizationId),
      eq(entitlements.memberId, memberId),
    )!,
  );
  const softDeletedGroups = await softDeleteAssignments(
    executor,
    and(
      eq(groupMembers.organizationId, organizationId),
      eq(groupMembers.memberId, memberId),
    )!,
  );
  return { removedGrants, softDeletedGroups };
}

/** Stable membership configuration; excludes user/group projections and clock-derived access. */
export async function findMemberConfiguration(
  context:
    | TenantReadContext<"configuration">
    | TenantReadContext<"memberAccess">
    | TenantMemberContext,
  memberId: string,
) {
  const { tx: executor, organizationId } = context;
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
    .where(
      and(isNull(members.deletedAt), memberWhere(organizationId, memberId)),
    );
  const [row] = await (context.access === "command"
    ? query.for("update")
    : query);
  if (context.access === "command") await context.revalidate();
  return row ?? null;
}

/** Assignment checks need membership state, not personal data or group projections. */
export async function findMemberForAssignment(
  context: PlatformWriteContext,
  organizationId: string,
  memberId: string,
) {
  const { tx } = context;
  const [row] = await tx
    .select({ membershipStatus: members.status })
    .from(members)
    .where(
      and(isNull(members.deletedAt), memberWhere(organizationId, memberId)),
    );
  return row ?? null;
}
