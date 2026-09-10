import { withDatabaseScope } from "../isolation.ts";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { Executor } from "../client.ts";
import {
  oauthResources,
  members,
  organizations,
  systemBindings,
  users,
} from "../schema/index.ts";
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
  principal: { userId: string },
  resource: string,
): Promise<Grant[]> {
  return withDatabaseScope(
    executor,
    { kind: "policy-user", userId: principal.userId },
    async (tx) => {
      // Policy writers hold the organisation row. Keep the discovered authority
      // stable until the enclosing command commits, then evaluate after the locks.
      const locked = await tx
        .select({ id: organizations.id })
        .from(members)
        .innerJoin(organizations, eq(organizations.id, members.organizationId))
        .where(eq(members.userId, principal.userId))
        .orderBy(organizations.id)
        .for("share", { of: organizations });
      await tx
        .select({ id: oauthResources.id })
        .from(oauthResources)
        .where(eq(oauthResources.identifier, resource))
        .for("share");
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
            eq(members.userId, principal.userId),
            inArray(
              members.organizationId,
              locked.map((row) => row.id),
            ),
          ),
        )
        .orderBy(organizations.slug);
      return rows.flatMap((row) => {
        const decision = evaluateAdminPermission(row);
        return decision.allowed
          ? [
              {
                organizationId: row.organizationId,
                organizationSlug: row.organizationSlug,
                isPlatform: row.isPlatform,
                scopes: decision.scopes,
              },
            ]
          : [];
      });
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
    await tx
      .select({ id: users.id })
      .from(users)
      .where(
        inArray(
          users.id,
          tx
            .select({ id: members.userId })
            .from(members)
            .where(inArray(members.organizationId, organizationIds)),
        ),
      )
      .orderBy(users.id)
      .for("share");
    await tx
      .select({ id: oauthResources.id })
      .from(oauthResources)
      .where(eq(oauthResources.identifier, input.resource))
      .for("share");
    const rows = await tx
      .select(memberPermissionFields(tx, false))
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .innerJoin(organizations, eq(organizations.id, members.organizationId))
      .innerJoin(oauthResources, eq(oauthResources.identifier, input.resource))
      .where(inArray(organizations.id, organizationIds));
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
