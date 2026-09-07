import { and, eq, isNull, sql } from "drizzle-orm";

import type { Database } from "./db/client.ts";
import { recordAuditEvent } from "./db/queries/audit.ts";
import { createEntitlement } from "./db/queries/entitlements.ts";
import { createGroup } from "./db/queries/groups.ts";
import {
  entitlements,
  groups,
  oauthResources,
  organizations,
} from "./db/schema/index.ts";
import { adminScopes, type AdminScope } from "./http/admin/scopes.ts";
import { createId } from "./lib/id.ts";
import type { Actor } from "./services/actor.ts";

export function systemActor(requestId: string): Actor {
  return { actorType: "system", actorId: "startup", requestId };
}

export const platformScopes = adminScopes.filter(
  (scope): scope is Extract<AdminScope, `platform:${string}`> =>
    scope.startsWith("platform:"),
);
export const platformAdminsGroupSlug = "platform-admins";

export type BootstrapOptions = {
  platformOrganizationSlug: string;
  platformOrganizationName: string;
  adminResourceIdentifier: string;
};

export type BootstrapResult = {
  organization: {
    id: string;
    slug: string;
    created: boolean;
    updated: boolean;
  };
  resource: {
    id: string;
    identifier: string;
    created: boolean;
    updated: boolean;
  };
  group: { id: string; created: boolean };
  entitlement: { id: string; created: boolean; updated: boolean };
};

const same = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);

export async function bootstrap(
  db: Database,
  actor: Actor,
  options: BootstrapOptions,
): Promise<BootstrapResult> {
  return db.transaction(async (tx) => {
    // Serialise concurrent startup seeds, including the first insert.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('answerable:bootstrap'))`,
    );
    let [organization] = await tx
      .select()
      .from(organizations)
      .where(eq(organizations.slug, options.platformOrganizationSlug));
    const organizationCreated = !organization;
    const organizationUpdated =
      !!organization && organization.name !== options.platformOrganizationName;
    if (!organization) {
      [organization] = await tx
        .insert(organizations)
        .values({
          id: createId(),
          slug: options.platformOrganizationSlug,
          name: options.platformOrganizationName,
        })
        .returning();
    } else if (organizationUpdated) {
      await tx
        .update(organizations)
        .set({ name: options.platformOrganizationName })
        .where(eq(organizations.id, organization.id));
    }
    const organizationId = organization!.id;
    const resourceFields = {
      name: "Answerable ID admin API",
      accessTokenTtl: 600,
      allowedScopes: [...adminScopes],
    };
    let [resource] = await tx
      .select()
      .from(oauthResources)
      .where(eq(oauthResources.identifier, options.adminResourceIdentifier));
    const resourceCreated = !resource;
    const resourceUpdated =
      !!resource &&
      (resource.name !== resourceFields.name ||
        resource.accessTokenTtl !== resourceFields.accessTokenTtl ||
        !same(resource.allowedScopes, resourceFields.allowedScopes));
    if (!resource) {
      [resource] = await tx
        .insert(oauthResources)
        .values({
          id: createId(),
          identifier: options.adminResourceIdentifier,
          ...resourceFields,
        })
        .returning();
    } else if (resourceUpdated) {
      await tx
        .update(oauthResources)
        .set(resourceFields)
        .where(eq(oauthResources.id, resource.id));
    }

    let [group] = await tx
      .select()
      .from(groups)
      .where(
        and(
          eq(groups.organizationId, organizationId),
          eq(groups.slug, platformAdminsGroupSlug),
        ),
      );
    const groupCreated = !group;
    if (!group)
      group = await createGroup(tx, {
        organizationId,
        slug: platformAdminsGroupSlug,
        name: "Platform admins",
      });
    let [entitlement] = await tx
      .select()
      .from(entitlements)
      .where(
        and(
          eq(entitlements.organizationId, organizationId),
          eq(entitlements.groupId, group.id),
          eq(entitlements.resource, options.adminResourceIdentifier),
          isNull(entitlements.memberId),
          isNull(entitlements.clientId),
        ),
      );
    const entitlementCreated = !entitlement;
    const entitlementUpdated =
      !!entitlement && !same(entitlement.scopes, platformScopes);
    if (!entitlement)
      entitlement = await createEntitlement(tx, {
        organizationId,
        groupId: group.id,
        resource: options.adminResourceIdentifier,
        scopes: [...platformScopes],
      });
    else if (entitlementUpdated)
      await tx
        .update(entitlements)
        .set({ scopes: [...platformScopes] })
        .where(eq(entitlements.id, entitlement.id));

    await recordAuditEvent(tx, {
      ...actor,
      organizationId,
      action: "bootstrap.applied",
      targetType: "organization",
      targetId: organizationId,
      outcome: "success",
      data: {
        organization: {
          created: organizationCreated,
          updated: organizationUpdated,
        },
        resource: { created: resourceCreated, updated: resourceUpdated },
        group: { created: groupCreated, updated: false },
        entitlement: {
          created: entitlementCreated,
          updated: entitlementUpdated,
        },
      },
    });
    return {
      organization: {
        id: organizationId,
        slug: organization!.slug,
        created: organizationCreated,
        updated: organizationUpdated,
      },
      resource: {
        id: resource!.id,
        identifier: resource!.identifier,
        created: resourceCreated,
        updated: resourceUpdated,
      },
      group: { id: group.id, created: groupCreated },
      entitlement: {
        id: entitlement.id,
        created: entitlementCreated,
        updated: entitlementUpdated,
      },
    };
  });
}
