import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";

import type { Executor } from "../client.ts";
import {
  entitlements,
  groupMembers,
  groups,
  members,
  organizations,
} from "../schema/index.ts";
import { isEffective } from "./effective.ts";

export type Grant = {
  organizationId: string;
  organizationSlug: string;
  scopes: string[];
};

export function matchingEntitlements(executor: Executor) {
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

export async function effectiveGrants(
  executor: Executor,
  principal: { userId: string },
  resource: string,
): Promise<Grant[]> {
  return executor
    .select({
      organizationId: members.organizationId,
      organizationSlug: organizations.slug,
      scopes: sql<string[]>`array_agg(distinct s.scope order by s.scope)`,
    })
    .from(members)
    .innerJoin(
      organizations,
      and(
        eq(organizations.id, members.organizationId),
        eq(organizations.status, "active"),
      ),
    )
    .innerJoin(
      entitlements,
      and(
        matchingEntitlements(executor),
        eq(entitlements.resource, resource),
        isNull(entitlements.clientId),
      ),
    )
    .crossJoinLateral(sql`unnest(${entitlements.scopes}) as s(scope)`)
    .where(and(eq(members.userId, principal.userId), isEffective(members)))
    .groupBy(members.organizationId, organizations.slug)
    .orderBy(organizations.slug);
}

export async function hasPlatformWriter(
  executor: Executor,
  input: { organizationSlug: string; resource: string },
): Promise<boolean> {
  const rows = await executor
    .select({ id: members.id })
    .from(members)
    .innerJoin(
      organizations,
      and(
        eq(organizations.id, members.organizationId),
        eq(organizations.status, "active"),
      ),
    )
    .innerJoin(
      entitlements,
      and(
        matchingEntitlements(executor),
        eq(entitlements.resource, input.resource),
        isNull(entitlements.clientId),
      ),
    )
    .where(
      and(
        eq(organizations.slug, input.organizationSlug),
        isEffective(members),
        sql`${entitlements.scopes} @> ARRAY['platform:write']::text[]`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}
