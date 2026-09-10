import {
  requireTenantDirectoryContext,
  type TenantReadContext,
} from "../../services/tenant-context.ts";
import {
  requirePlatformWriteContext,
  type PlatformWriteContext,
} from "../../services/platform-context.ts";
import { and, desc, eq, ilike, or, sql, getTableColumns } from "drizzle-orm";
import { beforeCursor, type PageQuery } from "../../http/pagination.ts";
import type { LifecycleStatus } from "../schema/vocabulary.ts";
import { isEffective } from "./effective.ts";
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
  /** Set when the group mirrors an upstream directory group. */
  externalId?: string;
};

export async function createGroup(
  context: PlatformWriteContext,
  input: CreateGroupInput,
) {
  const { tx: db } = requirePlatformWriteContext(context);
  const [group] = await db
    .insert(groups)
    .values({ id: createId(), ...input })
    .returning();

  return group!;
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
  context: TenantReadContext<"directory">,
  query: GroupQuery,
) {
  const { tx: executor, organizationId } =
    requireTenantDirectoryContext(context);
  return executor
    .select()
    .from(groups)
    .where(
      and(
        sql`${groups.deletedAt} is null`,
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
function findGroupQuery(
  executor: Executor,
  organizationId: string,
  groupId: string,
) {
  return executor
    .select()
    .from(groups)
    .where(
      and(
        sql`${groups.deletedAt} is null`,
        groupWhere(organizationId, groupId),
      ),
    );
}
export async function findGroup(
  context: TenantReadContext<"directory">,
  groupId: string,
) {
  const { tx, organizationId } = requireTenantDirectoryContext(context);
  const [row] = await findGroupQuery(tx, organizationId, groupId);
  return row ?? null;
}
export async function findGroupForCommand(
  context: PlatformWriteContext,
  organizationId: string,
  groupId: string,
) {
  const { tx } = requirePlatformWriteContext(context);
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
  const { tx: executor } = requirePlatformWriteContext(context);
  const [row] = await executor
    .update(groups)
    .set(patch)
    .where(
      and(
        sql`${groups.deletedAt} is null`,
        groupWhere(organizationId, groupId),
      ),
    )
    .returning();
  return row ?? null;
}
export async function setGroupStatus(
  context: PlatformWriteContext,
  organizationId: string,
  groupId: string,
  status: LifecycleStatus,
) {
  const { tx: executor } = requirePlatformWriteContext(context);
  const [row] = await executor
    .update(groups)
    .set({ status })
    .where(
      and(
        sql`${groups.deletedAt} is null`,
        groupWhere(organizationId, groupId),
      ),
    )
    .returning();
  return row ?? null;
}
const groupAssignmentEvidence = {
  id: groupMembers.id,
  revision: groupMembers.revision,
  organizationId: groupMembers.organizationId,
  groupId: groupMembers.groupId,
  memberId: groupMembers.memberId,
  userId: sql<string>`(select ${members.userId} from ${members} where ${members.id} = ${groupMembers.memberId} and ${members.organizationId} = ${groupMembers.organizationId})`,
  validFrom: groupMembers.validFrom,
  validUntil: groupMembers.validUntil,
};
const groupEntitlementEvidence = {
  id: entitlements.id,
  revision: entitlements.revision,
  organizationId: entitlements.organizationId,
  groupId: entitlements.groupId,
  memberId: entitlements.memberId,
  clientId: entitlements.clientId,
  resource: entitlements.resource,
  scopes: entitlements.scopes,
  status: entitlements.status,
  validFrom: entitlements.validFrom,
  validUntil: entitlements.validUntil,
};

export async function readGroupPolicyForCommand(
  context: PlatformWriteContext,
  organizationId: string,
  groupId: string,
) {
  const { tx } = requirePlatformWriteContext(context);
  // The caller holds organisation/group locks; child locks also order global
  // user cascades through capture and the command's audit/receipt commit.
  const assignments = await tx
    .select(groupAssignmentEvidence)
    .from(groupMembers)
    .where(
      and(
        sql`${groupMembers.deletedAt} is null`,
        membershipWhere(organizationId, groupId),
      ),
    )
    .orderBy(groupMembers.id)
    .for("share");
  const policy = await tx
    .select(groupEntitlementEvidence)
    .from(entitlements)
    .where(
      and(
        sql`${entitlements.deletedAt} is null`,
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
  const { tx: executor } = requirePlatformWriteContext(context);
  // The service holds the parent group lock, preventing new child rows while
  // UPDATE RETURNING captures the actual effects, including ineligible policy.
  const softDeletedAssignments = await executor
    .update(groupMembers)
    .set({ deletedAt: sql`now()` })
    .where(
      and(
        sql`${groupMembers.deletedAt} is null`,
        membershipWhere(organizationId, groupId),
      ),
    )
    .returning({
      ...groupAssignmentEvidence,
      deletedAt: groupMembers.deletedAt,
    });
  const softDeletedEntitlements = await executor
    .update(entitlements)
    .set({ deletedAt: sql`now()`, status: "disabled" })
    .where(
      and(
        sql`${entitlements.deletedAt} is null`,
        eq(entitlements.organizationId, organizationId),
        eq(entitlements.groupId, groupId),
      ),
    )
    .returning({
      ...groupEntitlementEvidence,
      deletedAt: entitlements.deletedAt,
    });
  const [row] = await executor
    .update(groups)
    .set({ deletedAt: sql`now()`, status: "disabled" })
    .where(
      and(
        sql`${groups.deletedAt} is null`,
        groupWhere(organizationId, groupId),
      ),
    )
    .returning();
  return {
    row: row!,
    effects: {
      softDeletedAssignments: softDeletedAssignments.sort((a, b) =>
        a.id.localeCompare(b.id),
      ),
      softDeletedEntitlements: softDeletedEntitlements.sort((a, b) =>
        a.id.localeCompare(b.id),
      ),
    },
  };
}
export function listGroupMembers(
  context: TenantReadContext<"directory">,
  groupId: string,
  query: PageQuery,
) {
  const { tx: executor, organizationId } =
    requireTenantDirectoryContext(context);
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
        sql`${users.deletedAt} is null`,
        sql`${members.deletedAt} is null`,
        sql`${groupMembers.deletedAt} is null`,
        membershipWhere(organizationId, groupId),
        beforeCursor(groupMembers.memberId, query.cursor),
      ),
    )
    .orderBy(desc(groupMembers.memberId))
    .limit(query.limit + 1);
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
        sql`${groupMembers.deletedAt} is null`,
        membershipWhere(organizationId, groupId, memberId),
      ),
    );
}
export async function findGroupMember(
  context: TenantReadContext<"directory">,
  groupId: string,
  memberId: string,
) {
  const { tx, organizationId } = requireTenantDirectoryContext(context);
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
  const { tx } = requirePlatformWriteContext(context);
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
  const { tx: executor } = requirePlatformWriteContext(context);
  // xmax distinguishes insertion from the conflict update in the same statement.
  const [result] = await executor
    .insert(groupMembers)
    .values({ ...input, id: createId() })
    .onConflictDoUpdate({
      target: [groupMembers.groupId, groupMembers.memberId],
      targetWhere: sql`${groupMembers.deletedAt} is null`,
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
  const { tx: executor } = requirePlatformWriteContext(context);
  const rows = await executor
    .update(groupMembers)
    .set({ deletedAt: sql`now()` })
    .where(
      and(
        sql`${groupMembers.deletedAt} is null`,
        membershipWhere(organizationId, groupId, memberId),
      ),
    )
    .returning();
  return rows[0] ?? null;
}
