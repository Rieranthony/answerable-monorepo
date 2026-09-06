import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Executor } from "../client.ts";
import {
  entitlements,
  groupMembers,
  groups,
  members,
  organizations,
  users,
} from "../schema/index.ts";
import { beforeCursor, type PageQuery } from "../../http/pagination.ts";
import { isEffective } from "./effective.ts";

export type AccessTarget = { clientId: string } | { resource: string };
export type MemberAccess = {
  effective: boolean;
  targets: Array<{
    kind: "client" | "resource";
    id: string;
    scopes: string[];
    via: Array<{
      entitlementId: string;
      principal: "organization" | "group" | "member";
      groupId: string | null;
    }>;
  }>;
};
// Keep the principal match identical to effectiveGrants: grants are additive.
function matchingEntitlements(executor: Executor) {
  return and(
    eq(entitlements.organizationId, members.organizationId),
    isEffective(entitlements),
    or(
      and(isNull(entitlements.memberId), isNull(entitlements.groupId)),
      eq(entitlements.memberId, members.id),
      inArray(
        entitlements.groupId,
        executor
          .select({ groupId: groupMembers.groupId })
          .from(groupMembers)
          .innerJoin(groups, eq(groups.id, groupMembers.groupId))
          .where(
            and(
              eq(groupMembers.memberId, members.id),
              eq(groups.status, "active"),
              isEffective(groupMembers),
            ),
          ),
      ),
    ),
  );
}
const activeOrganization = and(
  eq(organizations.id, members.organizationId),
  eq(organizations.status, "active"),
);
export async function memberAccess(
  executor: Executor,
  organizationId: string,
  memberId: string,
): Promise<MemberAccess> {
  const rows = await executor
    .select({ entitlement: entitlements })
    .from(members)
    .innerJoin(organizations, activeOrganization)
    .leftJoin(entitlements, matchingEntitlements(executor))
    .where(
      and(
        eq(members.organizationId, organizationId),
        eq(members.id, memberId),
        isEffective(members),
      ),
    )
    .orderBy(entitlements.id);
  const targets = new Map<string, MemberAccess["targets"][number]>();
  for (const { entitlement: row } of rows) {
    if (!row) continue;
    const kind = row.clientId !== null ? "client" : "resource";
    const id = row.clientId ?? row.resource!;
    const key = `${kind}:${id}`;
    let target = targets.get(key);
    if (!target) {
      target = { kind, id, scopes: [], via: [] };
      targets.set(key, target);
    }
    target.scopes = [...new Set([...target.scopes, ...row.scopes])].sort();
    target.via.push({
      entitlementId: row.id,
      principal:
        row.memberId !== null
          ? "member"
          : row.groupId !== null
            ? "group"
            : "organization",
      groupId: row.groupId,
    });
  }
  return { effective: rows.length > 0, targets: [...targets.values()] };
}
export async function targetAccess(
  executor: Executor,
  organizationId: string,
  target: AccessTarget,
  page: PageQuery,
) {
  const rows = await executor
    .select({
      memberId: members.id,
      userId: users.id,
      email: users.email,
      name: users.name,
      scopes: sql<string[]>`array_agg(distinct s.scope order by s.scope)`,
    })
    .from(members)
    .innerJoin(organizations, activeOrganization)
    .innerJoin(users, eq(users.id, members.userId))
    .innerJoin(
      entitlements,
      and(
        matchingEntitlements(executor),
        "clientId" in target
          ? and(
              eq(entitlements.clientId, target.clientId),
              isNull(entitlements.resource),
            )
          : and(
              eq(entitlements.resource, target.resource),
              isNull(entitlements.clientId),
            ),
      ),
    )
    .crossJoinLateral(sql`unnest(${entitlements.scopes}) as s(scope)`)
    .where(
      and(
        eq(members.organizationId, organizationId),
        isEffective(members),
        beforeCursor(members.id, page.cursor),
      ),
    )
    .groupBy(members.id, users.id, users.email, users.name)
    .orderBy(desc(members.id))
    .limit(page.limit + 1);
  const items = rows.slice(0, page.limit);
  return {
    items,
    nextCursor:
      rows.length > page.limit ? items[items.length - 1].memberId : null,
  };
}
