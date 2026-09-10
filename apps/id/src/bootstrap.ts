import { setDatabaseScope } from "./db/isolation.ts";
import { and, eq, isNull, sql } from "drizzle-orm";

import type { Database } from "./db/client.ts";
import { recordAuditEvent } from "./db/queries/audit.ts";
import {
  entitlements,
  organizationCapabilities,
  groups,
  oauthResources,
  organizations,
  systemBindings,
} from "./db/schema/index.ts";
import { adminScopes, type AdminScope } from "./http/admin/scopes.ts";
import { createId } from "./lib/id.ts";
import type { Actor } from "./services/actor.ts";
import { ProblemError } from "./http/problem.ts";

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
    const [binding] = await tx
      .select()
      .from(systemBindings)
      .where(eq(systemBindings.name, "platform"));
    const conflict = () =>
      new ProblemError(
        409,
        "system_binding_conflict",
        "System identity conflict",
        "Existing records require an explicitly reviewed system binding; names do not establish ownership.",
      );
    let [organization] = await tx
      .select()
      .from(organizations)
      .where(
        binding
          ? eq(organizations.id, binding.organizationId)
          : eq(organizations.slug, options.platformOrganizationSlug),
      );
    if (!binding && organization) throw conflict();
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
    await setDatabaseScope(tx, {
      kind: "tenant",
      access: "write",
      organizationId,
    });
    const resourceFields = {
      name: "Answerable ID admin API",
      accessTokenTtl: 600,
      allowedScopes: [...adminScopes],
    };
    let [resource] = await tx
      .select()
      .from(oauthResources)
      .where(
        binding
          ? eq(oauthResources.id, binding.resourceId)
          : eq(oauthResources.identifier, options.adminResourceIdentifier),
      );
    if (
      resource &&
      (!binding || resource.identifier !== options.adminResourceIdentifier)
    )
      throw conflict();
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
          binding
            ? eq(groups.id, binding.groupId)
            : eq(groups.slug, platformAdminsGroupSlug),
        ),
      );
    const groupCreated = !group;
    if (!group)
      [group] = await tx
        .insert(groups)
        .values({
          id: createId(),
          organizationId,
          slug: platformAdminsGroupSlug,
          name: "Platform admins",
        })
        .returning();
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
      [entitlement] = await tx
        .insert(entitlements)
        .values({
          id: createId(),
          organizationId,
          groupId: group.id,
          resource: options.adminResourceIdentifier,
          scopes: [...platformScopes],
        })
        .returning();
    else if (entitlementUpdated)
      await tx
        .update(entitlements)
        .set({ scopes: [...platformScopes] })
        .where(eq(entitlements.id, entitlement.id));

    if (!binding)
      await tx.insert(systemBindings).values({
        name: "platform",
        organizationId,
        resourceId: resource!.id,
        groupId: group.id,
      });
    // The established immutable binding is the authority for this system ceiling.
    // Existing restrictions survive restart; only first provision inserts defaults.
    await setDatabaseScope(tx, { kind: "platform", access: "write" });
    const insertedCapabilities = await tx
      .insert(organizationCapabilities)
      .values({
        id: createId(),
        organizationId,
        resource: options.adminResourceIdentifier,
        grantKind: "admin_session",
        scopes: [...adminScopes],
      })
      .onConflictDoNothing({
        target: [
          organizationCapabilities.organizationId,
          organizationCapabilities.clientId,
          organizationCapabilities.resource,
          organizationCapabilities.grantKind,
        ],
      })
      .returning();
    const [capability] = insertedCapabilities.length
      ? insertedCapabilities
      : await tx
          .select()
          .from(organizationCapabilities)
          .where(
            and(
              eq(organizationCapabilities.organizationId, organizationId),
              eq(
                organizationCapabilities.resource,
                options.adminResourceIdentifier,
              ),
              isNull(organizationCapabilities.clientId),
              eq(organizationCapabilities.grantKind, "admin_session"),
            ),
          );
    await setDatabaseScope(tx, {
      kind: "tenant",
      access: "write",
      organizationId,
    });
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
        capability: {
          created: insertedCapabilities.length > 0,
          updated: false,
          after: capability!,
        },
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
