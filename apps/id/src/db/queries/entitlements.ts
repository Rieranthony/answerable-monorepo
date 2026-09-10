import {
  requireTenantDirectoryContext,
  type TenantReadContext,
} from "../../services/tenant-context.ts";
import {
  requirePlatformWriteContext,
  requirePlatformReadContext,
  type PlatformWriteContext,
  type PlatformReadContext,
} from "../../services/platform-context.ts";
import { and, desc, eq, getTableColumns, sql } from "drizzle-orm";
import { beforeCursor, type PageQuery } from "../../http/pagination.ts";
import type { LifecycleStatus } from "../schema/vocabulary.ts";
import type { MemberWindow } from "./groups.ts";
import { createId } from "../../lib/id.ts";
import type { Executor } from "../client.ts";
import {
  entitlements,
  organizations,
  members,
  groupMembers,
} from "../schema/index.ts";

export type CreateEntitlementInput = {
  organizationId: string;
  /** Principal: omit both for an organization-wide grant. */
  memberId?: string;
  groupId?: string;
  /** Target: a client, a resource, or an exact client/resource pair. */
  clientId?: string;
  resource?: string;
  scopes: string[];
} & MemberWindow;

export async function createEntitlement(
  context: PlatformWriteContext,
  input: CreateEntitlementInput,
) {
  const { tx: db } = requirePlatformWriteContext(context);
  const [entitlement] = await db
    .insert(entitlements)
    .values({ id: createId(), ...input })
    .returning();

  return entitlement!;
}

export type EntitlementQuery = PageQuery & {
  clientId?: string;
  resource?: string;
  memberId?: string;
  groupId?: string;
  status?: LifecycleStatus;
};
export type EntitlementPatch = MemberWindow & { scopes?: string[] };
const entitlementWhere = (organizationId: string, entitlementId: string) =>
  and(
    eq(entitlements.organizationId, organizationId),
    eq(entitlements.id, entitlementId),
  );
export function listEntitlements(
  context: TenantReadContext<"directory">,
  query: EntitlementQuery,
) {
  const { tx: executor, organizationId } =
    requireTenantDirectoryContext(context);
  return executor
    .select()
    .from(entitlements)
    .where(
      and(
        sql`${entitlements.deletedAt} is null`,
        eq(entitlements.organizationId, organizationId),
        query.clientId === undefined
          ? undefined
          : eq(entitlements.clientId, query.clientId),
        query.resource === undefined
          ? undefined
          : eq(entitlements.resource, query.resource),
        query.memberId === undefined
          ? undefined
          : eq(entitlements.memberId, query.memberId),
        query.groupId === undefined
          ? undefined
          : eq(entitlements.groupId, query.groupId),
        query.status === undefined
          ? undefined
          : eq(entitlements.status, query.status),
        beforeCursor(entitlements.id, query.cursor),
      ),
    )
    .orderBy(desc(entitlements.id))
    .limit(query.limit + 1);
}
function findEntitlementQuery(
  executor: Executor,
  organizationId: string,
  entitlementId: string,
) {
  return executor
    .select()
    .from(entitlements)
    .where(
      and(
        sql`${entitlements.deletedAt} is null`,
        entitlementWhere(organizationId, entitlementId),
      ),
    );
}
export async function findEntitlement(
  context: TenantReadContext<"directory">,
  entitlementId: string,
) {
  const { tx, organizationId } = requireTenantDirectoryContext(context);
  const [row] = await findEntitlementQuery(tx, organizationId, entitlementId);
  return row ?? null;
}
export async function findEntitlementForCommand(
  context: PlatformWriteContext,
  organizationId: string,
  entitlementId: string,
) {
  const { tx } = requirePlatformWriteContext(context);
  const [row] = await findEntitlementQuery(
    tx,
    organizationId,
    entitlementId,
  ).for("update");
  await context.revalidate();
  return row ?? null;
}
export async function updateEntitlement(
  context: PlatformWriteContext,
  organizationId: string,
  entitlementId: string,
  patch: EntitlementPatch,
) {
  const { tx: executor } = requirePlatformWriteContext(context);
  const [row] = await executor
    .update(entitlements)
    .set(patch)
    .where(
      and(
        sql`${entitlements.deletedAt} is null`,
        entitlementWhere(organizationId, entitlementId),
      ),
    )
    .returning();
  return row ?? null;
}
export async function setEntitlementStatus(
  context: PlatformWriteContext,
  organizationId: string,
  entitlementId: string,
  status: LifecycleStatus,
) {
  const { tx: executor } = requirePlatformWriteContext(context);
  const [row] = await executor
    .update(entitlements)
    .set({ status })
    .where(
      and(
        sql`${entitlements.deletedAt} is null`,
        entitlementWhere(organizationId, entitlementId),
      ),
    )
    .returning();
  return row ?? null;
}
export async function deleteEntitlement(
  context: PlatformWriteContext,
  organizationId: string,
  entitlementId: string,
) {
  const { tx: executor } = requirePlatformWriteContext(context);
  const [row] = await executor
    .update(entitlements)
    .set({ deletedAt: sql`now()`, status: "disabled" })
    .where(
      and(
        sql`${entitlements.deletedAt} is null`,
        entitlementWhere(organizationId, entitlementId),
      ),
    )
    .returning();
  return row ?? null;
}

/** The command holds the organisation lock. Capture current source membership,
 * including ineligible rows, and order parent erasure through audit commit. */
export async function readEntitlementAudience(
  context: PlatformWriteContext,
  organizationId: string,
  groupId: string | null,
) {
  const { tx } = requirePlatformWriteContext(context);
  const membership = {
    memberId: members.id,
    userId: members.userId,
    organizationId: members.organizationId,
    revision: members.revision,
    status: members.status,
    validFrom: members.validFrom,
    validUntil: members.validUntil,
  };
  if (groupId !== null) {
    const rows = await tx
      .select({
        ...membership,
        groupAssignment: {
          id: groupMembers.id,
          revision: groupMembers.revision,
          groupId: groupMembers.groupId,
          validFrom: groupMembers.validFrom,
          validUntil: groupMembers.validUntil,
        },
      })
      .from(members)
      .innerJoin(
        groupMembers,
        and(
          eq(groupMembers.memberId, members.id),
          eq(groupMembers.organizationId, members.organizationId),
        ),
      )
      .where(
        and(
          sql`${groupMembers.deletedAt} is null`,
          sql`${members.deletedAt} is null`,
          eq(members.organizationId, organizationId),
          eq(groupMembers.groupId, groupId),
        ),
      )
      .orderBy(members.id)
      .for("share", { of: [members, groupMembers] });
    await context.revalidate();
    return rows;
  }
  const rows = await tx
    .select({ ...membership, groupAssignment: sql<null>`null` })
    .from(members)
    .where(
      and(
        sql`${members.deletedAt} is null`,
        eq(members.organizationId, organizationId),
      ),
    )
    .orderBy(members.id)
    .for("share");
  await context.revalidate();
  return rows;
}

export function listAllEntitlements(
  context: PlatformReadContext,
  query: EntitlementQuery,
) {
  const { tx: executor } = requirePlatformReadContext(context);
  return executor
    .select({
      ...getTableColumns(entitlements),
      organization: { id: organizations.id, slug: organizations.slug },
    })
    .from(entitlements)
    .innerJoin(organizations, eq(organizations.id, entitlements.organizationId))
    .where(
      and(
        sql`${organizations.deletedAt} is null`,
        sql`${entitlements.deletedAt} is null`,
        query.clientId === undefined
          ? undefined
          : eq(entitlements.clientId, query.clientId),
        query.resource === undefined
          ? undefined
          : eq(entitlements.resource, query.resource),
        query.memberId === undefined
          ? undefined
          : eq(entitlements.memberId, query.memberId),
        query.groupId === undefined
          ? undefined
          : eq(entitlements.groupId, query.groupId),
        query.status === undefined
          ? undefined
          : eq(entitlements.status, query.status),
        beforeCursor(entitlements.id, query.cursor),
      ),
    )
    .orderBy(desc(entitlements.id))
    .limit(query.limit + 1);
}
