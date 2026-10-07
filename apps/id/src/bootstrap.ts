import { setDatabaseScope } from "./db/isolation.ts";
import { eq, sql } from "drizzle-orm";

import type { Executor, Database } from "./db/client.ts";
import { lockOrganization } from "./db/locks.ts";
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
  organizationId: string;
  slug: string;
  groupId: string;
  resourceId: string;
  /** True when this start provisioned the platform. */
  created: boolean;
};

type Binding = typeof systemBindings.$inferSelect;
type ResourceDefinition = Pick<
  typeof oauthResources.$inferSelect,
  "name" | "accessTokenTtl" | "allowedScopes"
>;

/** The admin resource's definition belongs to the code: every start restores it. */
const adminResource: ResourceDefinition = {
  name: "Answerable ID admin API",
  accessTokenTtl: 600,
  allowedScopes: [...adminScopes],
};

const conflict = () =>
  new ProblemError(
    409,
    "system_binding_conflict",
    "System identity conflict",
    "Existing records require an explicitly reviewed system binding; names do not establish ownership.",
  );

/**
 * The first start provisions the platform organisation, its admin resource,
 * the platform-admins group, its entitlement, the platform capability and the
 * binding between them. Every later start verifies the binding and restores
 * only the admin resource's definition; the rest belongs to operators.
 */
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
    return binding
      ? verify(tx, actor, binding, options)
      : provision(tx, actor, options);
  });
}

async function provision(
  tx: Executor,
  actor: Actor,
  options: BootstrapOptions,
): Promise<BootstrapResult> {
  // Slugs and resource identifiers stay reserved after deletion, so a
  // tombstone conflicts too.
  const [named] = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.slug, options.platformOrganizationSlug));
  if (named) throw conflict();
  const [organization] = await tx
    .insert(organizations)
    .values({
      id: createId(),
      slug: options.platformOrganizationSlug,
      name: options.platformOrganizationName,
    })
    .returning();
  const organizationId = organization!.id;
  await setDatabaseScope(tx, {
    kind: "tenant",
    access: "write",
    organizationId,
  });
  const [identified] = await tx
    .select({ id: oauthResources.id })
    .from(oauthResources)
    .where(eq(oauthResources.identifier, options.adminResourceIdentifier));
  if (identified) throw conflict();
  const [resource] = await tx
    .insert(oauthResources)
    .values({
      id: createId(),
      identifier: options.adminResourceIdentifier,
      ...adminResource,
    })
    .returning();
  const [group] = await tx
    .insert(groups)
    .values({
      id: createId(),
      organizationId,
      slug: platformAdminsGroupSlug,
      name: "Platform admins",
    })
    .returning();
  await tx.insert(entitlements).values({
    id: createId(),
    organizationId,
    groupId: group!.id,
    resource: options.adminResourceIdentifier,
    scopes: [...platformScopes],
  });
  await tx.insert(systemBindings).values({
    name: "platform",
    organizationId,
    resourceInstanceId: resource!.id,
    groupId: group!.id,
  });
  // The ceiling of every platform admin session; operators own it afterwards.
  await setDatabaseScope(tx, { kind: "platform", access: "write" });
  const [capability] = await tx
    .insert(organizationCapabilities)
    .values({
      id: createId(),
      organizationId,
      resource: options.adminResourceIdentifier,
      grantKind: "admin_session",
      scopes: [...adminScopes],
    })
    .returning();
  await setDatabaseScope(tx, {
    kind: "tenant",
    access: "write",
    organizationId,
  });
  await recordApplied(tx, actor, organizationId, {
    created: true,
    resource: { before: null, after: adminResource },
    capability: capability!,
  });
  return {
    organizationId,
    slug: organization!.slug,
    groupId: group!.id,
    resourceId: resource!.id,
    created: true,
  };
}

async function verify(
  tx: Executor,
  actor: Actor,
  binding: Binding,
  options: BootstrapOptions,
): Promise<BootstrapResult> {
  // The binding's live foreign keys keep the bound rows present and undeleted.
  const [organization] = await tx
    .select({ slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.id, binding.organizationId));
  await setDatabaseScope(tx, {
    kind: "tenant",
    access: "write",
    organizationId: binding.organizationId,
  });
  const [resource] = await tx
    .select()
    .from(oauthResources)
    .where(eq(oauthResources.id, binding.resourceInstanceId));
  if (resource!.identifier !== options.adminResourceIdentifier)
    throw conflict();
  const before: ResourceDefinition = {
    name: resource!.name,
    accessTokenTtl: resource!.accessTokenTtl,
    allowedScopes: resource!.allowedScopes,
  };
  if (JSON.stringify(before) !== JSON.stringify(adminResource)) {
    // Lock the organisation first, as root admission does: a definition that
    // restores platform:write activates a writer.
    await lockOrganization(tx, binding.organizationId);
    await tx
      .update(oauthResources)
      .set(adminResource)
      .where(eq(oauthResources.id, resource!.id));
    await recordApplied(tx, actor, binding.organizationId, {
      created: false,
      resource: { before, after: adminResource },
      capability: null,
    });
  }
  return {
    organizationId: binding.organizationId,
    slug: organization!.slug,
    groupId: binding.groupId,
    resourceId: binding.resourceInstanceId,
    created: false,
  };
}

/** Recorded only when a start created or changed something. */
function recordApplied(
  tx: Executor,
  actor: Actor,
  organizationId: string,
  data: {
    created: boolean;
    resource: { before: ResourceDefinition | null; after: ResourceDefinition };
    capability: typeof organizationCapabilities.$inferSelect | null;
  },
) {
  return recordAuditEvent(tx, {
    ...actor,
    organizationId,
    action: "bootstrap.applied",
    targetType: "organization",
    targetId: organizationId,
    outcome: "success",
    data,
  });
}
