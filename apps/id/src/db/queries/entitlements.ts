import { and, desc, eq } from "drizzle-orm";
import { beforeCursor, type PageQuery } from "../../http/pagination.ts";
import type { LifecycleStatus } from "../schema/vocabulary.ts";
import type { MemberWindow } from "./groups.ts";
import { createId } from "../../lib/id.ts";
import type { Executor } from "../client.ts";
import { entitlements } from "../schema/index.ts";

export type CreateEntitlementInput = {
  organizationId: string;
  /** Principal: omit both for an organization-wide grant. */
  memberId?: string;
  groupId?: string;
  /** Target: exactly one of an OAuth client id or an RFC 8707 resource. */
  clientId?: string;
  resource?: string;
  scopes: string[];
} & MemberWindow;

export async function createEntitlement(
  db: Executor,
  input: CreateEntitlementInput,
) {
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
  executor: Executor,
  organizationId: string,
  query: EntitlementQuery,
) {
  return executor
    .select()
    .from(entitlements)
    .where(
      and(
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
export async function findEntitlement(
  executor: Executor,
  organizationId: string,
  entitlementId: string,
) {
  const [row] = await executor
    .select()
    .from(entitlements)
    .where(entitlementWhere(organizationId, entitlementId));
  return row ?? null;
}
export async function updateEntitlement(
  executor: Executor,
  organizationId: string,
  entitlementId: string,
  patch: EntitlementPatch,
) {
  const [row] = await executor
    .update(entitlements)
    .set(patch)
    .where(entitlementWhere(organizationId, entitlementId))
    .returning();
  return row ?? null;
}
export async function setEntitlementStatus(
  executor: Executor,
  organizationId: string,
  entitlementId: string,
  status: LifecycleStatus,
) {
  const [row] = await executor
    .update(entitlements)
    .set({ status })
    .where(entitlementWhere(organizationId, entitlementId))
    .returning();
  return row ?? null;
}
export async function deleteEntitlement(
  executor: Executor,
  organizationId: string,
  entitlementId: string,
) {
  await executor
    .delete(entitlements)
    .where(entitlementWhere(organizationId, entitlementId));
}
