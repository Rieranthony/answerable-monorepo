import {
  evaluateUserResourcePermission,
  evaluateClientLoginPermission,
  evaluateAdminPermission,
  memberPermissionFields,
  memberPermissionView,
} from "../../auth/member-permission.ts";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  requireTenantMemberAccessContext,
  requireTenantMemberContext,
  requireTenantDirectoryContext,
  type TenantMemberContext,
  type TenantReadContext,
} from "../../services/tenant-context.ts";
import {
  entitlements,
  members,
  organizations,
  users,
  oauthClients,
  oauthResources,
} from "../schema/index.ts";
import { beforeCursor, type PageQuery } from "../../http/pagination.ts";
import { isEffective } from "./effective.ts";
import { matchingEntitlements } from "./effective.ts";

export type AccessTarget =
  | { clientId: string; resource?: string }
  | { resource: string; clientId?: string };
export type MemberAccess = {
  effective: boolean;
  targets: Array<
    (
      | { kind: "client" | "resource"; id: string }
      | { kind: "client_resource"; id: string; resource: string }
    ) & {
      permission: ReturnType<typeof memberPermissionView>;
      scopes: string[];
      via: Array<{
        entitlementId: string;
        principal: "organization" | "group" | "member";
        groupId: string | null;
      }>;
    }
  >;
};
const activeOrganization = and(
  eq(organizations.id, members.organizationId),
  eq(organizations.status, "active"),
);
export async function memberAccess(
  context: TenantReadContext<"memberAccess"> | TenantMemberContext,
  memberId: string,
): Promise<MemberAccess> {
  const { tx: executor, organizationId } =
    context.access === "command"
      ? requireTenantMemberContext(context)
      : requireTenantMemberAccessContext(context);
  // Group matching assignments before projecting policy facts. Otherwise every
  // entitlement repeats the full target source list in the database response.
  const assignedTargets = executor
    .select({
      clientId: entitlements.clientId,
      resource: entitlements.resource,
      firstId: sql<string>`min(${entitlements.id}::text)`.as("first_id"),
      sources: sql<
        Array<{
          id: string;
          memberId: string | null;
          groupId: string | null;
          scopes: string[];
        }>
      >`jsonb_agg(jsonb_build_object(
        'id', ${entitlements.id}, 'memberId', ${entitlements.memberId},
        'groupId', ${entitlements.groupId}, 'scopes', ${entitlements.scopes}
      ) order by ${entitlements.id})`.as("sources"),
    })
    .from(entitlements)
    .where(matchingEntitlements(executor))
    .groupBy(entitlements.clientId, entitlements.resource)
    .as("assigned_targets");
  const rows = await executor
    .select({
      targetClientId: assignedTargets.clientId,
      targetResource: assignedTargets.resource,
      targetAssignments: assignedTargets.sources,
      ...memberPermissionFields(executor),
    })
    .from(members)
    .innerJoin(
      users,
      and(eq(users.id, members.userId), eq(users.status, "active")),
    )
    .innerJoin(organizations, activeOrganization)
    .leftJoinLateral(assignedTargets, sql`true`)
    .leftJoin(oauthClients, eq(oauthClients.clientId, assignedTargets.clientId))
    .leftJoin(
      oauthResources,
      eq(oauthResources.identifier, assignedTargets.resource),
    )
    .where(
      and(
        eq(members.organizationId, organizationId),
        eq(members.id, memberId),
        isEffective(members),
      ),
    )
    .orderBy(assignedTargets.firstId);
  const targets: MemberAccess["targets"] = [];
  for (const facts of rows) {
    const sources = facts.targetAssignments;
    if (!sources) continue;
    const clientId = facts.targetClientId;
    const resource = facts.targetResource;
    const target: MemberAccess["targets"][number] =
      clientId !== null && resource !== null
        ? {
            kind: "client_resource",
            id: clientId,
            resource,
            permission: memberPermissionView(
              evaluateUserResourcePermission(facts, {
                resource,
                grantType: "authorization_code",
              }),
            ),
            scopes: [],
            via: [],
          }
        : {
            kind: clientId !== null ? "client" : "resource",
            id: clientId ?? resource!,
            permission:
              clientId !== null
                ? memberPermissionView(evaluateClientLoginPermission(facts))
                : memberPermissionView(evaluateAdminPermission(facts)),
            scopes: [],
            via: [],
          };
    target.scopes = [...new Set(sources.flatMap((row) => row.scopes))].sort();
    target.via = sources.map((row) => ({
      entitlementId: row.id,
      principal:
        row.memberId !== null
          ? "member"
          : row.groupId !== null
            ? "group"
            : "organization",
      groupId: row.groupId,
    }));
    targets.push(target);
  }
  return { effective: rows.length > 0, targets };
}
export async function targetAccess(
  context: TenantReadContext<"directory">,
  target: AccessTarget,
  page: PageQuery,
) {
  const { tx: executor, organizationId } =
    requireTenantDirectoryContext(context);
  const rows = await executor
    .select({
      memberId: members.id,
      email: users.email,
      name: users.name,
      scopes: sql<string[]>`array_agg(distinct s.scope order by s.scope)`,
      ...memberPermissionFields(executor),
    })
    .from(members)
    .innerJoin(organizations, activeOrganization)
    .innerJoin(
      users,
      and(eq(users.id, members.userId), eq(users.status, "active")),
    )
    .innerJoin(
      entitlements,
      and(
        matchingEntitlements(executor),
        target.clientId === undefined
          ? isNull(entitlements.clientId)
          : eq(entitlements.clientId, target.clientId),
        target.resource === undefined
          ? isNull(entitlements.resource)
          : eq(entitlements.resource, target.resource),
      ),
    )
    .leftJoin(oauthClients, eq(oauthClients.clientId, entitlements.clientId))
    .leftJoin(
      oauthResources,
      eq(oauthResources.identifier, entitlements.resource),
    )
    .crossJoinLateral(sql`unnest(${entitlements.scopes}) as s(scope)`)
    .where(
      and(
        eq(members.organizationId, organizationId),
        isEffective(members),
        beforeCursor(members.id, page.cursor),
      ),
    )
    .groupBy(
      members.id,
      users.id,
      users.email,
      users.name,
      organizations.id,
      oauthClients.id,
      oauthResources.id,
    )
    .orderBy(desc(members.id))
    .limit(page.limit + 1);
  const items = rows.slice(0, page.limit).map((row) => ({
    memberId: row.memberId,
    userId: row.userId,
    email: row.email,
    name: row.name,
    scopes: row.scopes,
    permission: memberPermissionView(
      target.clientId === undefined
        ? evaluateAdminPermission(row)
        : target.resource === undefined
          ? evaluateClientLoginPermission(row)
          : evaluateUserResourcePermission(row, {
              resource: target.resource,
              grantType: "authorization_code",
            }),
    ),
  }));
  return {
    items,
    nextCursor:
      rows.length > page.limit ? items[items.length - 1].memberId : null,
  };
}
