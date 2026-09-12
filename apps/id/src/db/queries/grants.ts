import { withDatabaseScope } from "../isolation.ts";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { Executor } from "../client.ts";
import {
  oauthResources,
  members,
  organizations,
  systemBindings,
  users,
  sessions,
} from "../schema/index.ts";
import { tenantAuthentication } from "../../auth/tenant-authentication.ts";
import {
  memberPermissionFields,
  evaluateAdminPermission,
} from "../../auth/member-permission.ts";

export type Grant = {
  organizationId: string;
  organizationSlug: string;
  isPlatform: boolean;
  scopes: string[];
};

export async function effectiveGrants(
  executor: Executor,
  principal: { userId: string; sessionId?: string },
  resource: string,
): Promise<Grant[]> {
  return withDatabaseScope(
    executor,
    { kind: "policy-user", userId: principal.userId },
    async (tx) => {
      let authenticationOrganizationId: string | undefined;
      if (principal.sessionId !== undefined) {
        const [session] = await tx
          .select({ organizationId: sessions.authenticationOrganizationId })
          .from(users)
          .innerJoin(sessions, eq(sessions.userId, users.id))
          .where(
            and(
              eq(users.id, principal.userId),
              eq(sessions.id, principal.sessionId),
            ),
          )
          .for("share");
        if (!session?.organizationId) return [];
        authenticationOrganizationId = session.organizationId;
      }
      // Policy writers hold the organisation row. Keep the discovered authority
      // stable until the enclosing command commits, then evaluate after the locks.
      const locked = await tx
        .select({ id: organizations.id })
        .from(members)
        .innerJoin(organizations, eq(organizations.id, members.organizationId))
        .where(
          and(
            sql`${organizations.deletedAt} is null`,
            sql`${members.deletedAt} is null`,
            eq(members.userId, principal.userId),
            authenticationOrganizationId === undefined
              ? undefined
              : eq(organizations.id, authenticationOrganizationId),
          ),
        )
        .orderBy(organizations.id)
        .for("share", { of: organizations });
      await tx
        .select({ id: oauthResources.id })
        .from(oauthResources)
        .where(
          and(
            sql`${oauthResources.deletedAt} is null`,
            eq(oauthResources.identifier, resource),
          ),
        )
        .for("share");
      // Native provider/account locks can wait too. Evaluate permission windows
      // only after the authentication decision has acquired those locks.
      if (
        principal.sessionId !== undefined &&
        !(await tenantAuthentication(tx, {
          userId: principal.userId,
          sessionId: principal.sessionId,
          organizationId: authenticationOrganizationId!,
        }))
      )
        return [];
      const rows = await tx
        .select({
          organizationId: members.organizationId,
          organizationSlug: organizations.slug,
          isPlatform: sql<boolean>`exists(select 1 from ${systemBindings} where ${systemBindings.organizationId} = ${members.organizationId})`,
          ...memberPermissionFields(tx, false),
        })
        .from(members)
        .innerJoin(users, eq(users.id, members.userId))
        .innerJoin(organizations, eq(organizations.id, members.organizationId))
        .innerJoin(oauthResources, eq(oauthResources.identifier, resource))
        .where(
          and(
            sql`${oauthResources.deletedAt} is null`,
            sql`${organizations.deletedAt} is null`,
            sql`${users.deletedAt} is null`,
            sql`${members.deletedAt} is null`,
            eq(members.userId, principal.userId),
            inArray(
              members.organizationId,
              locked.map((row) => row.id),
            ),
          ),
        )
        .orderBy(organizations.slug);
      const grants: Grant[] = [];
      for (const row of rows) {
        const decision = evaluateAdminPermission(row);
        if (decision.allowed)
          grants.push({
            organizationId: row.organizationId,
            organizationSlug: row.organizationSlug,
            isPlatform: row.isPlatform,
            scopes: decision.scopes,
          });
      }
      return grants;
    },
  );
}

export async function hasPlatformWriter(
  executor: Executor,
  input: { resource: string; noWait?: true; excludingUserId?: string },
): Promise<boolean> {
  return withDatabaseScope(executor, { kind: "policy-root" }, async (tx) => {
    // Root admission depends on the absence of a writer. FOR UPDATE also blocks
    // new platform memberships through their organisation foreign key.
    const platform = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .innerJoin(
        systemBindings,
        eq(systemBindings.organizationId, organizations.id),
      )
      .orderBy(organizations.id)
      .for(
        "update",
        input.noWait
          ? { of: organizations, noWait: true }
          : { of: organizations },
      );
    const organizationIds = platform.map((row) => row.id);
    const rows = await tx
      .select(memberPermissionFields(tx, false))
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .innerJoin(organizations, eq(organizations.id, members.organizationId))
      .innerJoin(oauthResources, eq(oauthResources.identifier, input.resource))
      .where(
        and(
          sql`${oauthResources.deletedAt} is null`,
          sql`${organizations.deletedAt} is null`,
          sql`${users.deletedAt} is null`,
          sql`${members.deletedAt} is null`,
          inArray(organizations.id, organizationIds),
        ),
      );
    return rows.some((row) => {
      const decision = evaluateAdminPermission(row);
      return (
        row.userId !== input.excludingUserId &&
        decision.allowed &&
        decision.scopes.includes("platform:write")
      );
    });
  });
}
