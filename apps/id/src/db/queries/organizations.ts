import {
  requirePlatformReadContext,
  requirePlatformWriteContext,
  type PlatformReadContext,
  type PlatformWriteContext,
} from "../../services/platform-context.ts";
import {
  requireTenantDirectoryContext,
  requireTenantMemberAccessContext,
  requireTenantHistoryContext,
  type TenantReadContext,
} from "../../services/tenant-context.ts";
import { lockOrganization } from "../organization-lock.ts";
import { and, count, desc, eq, ilike, or, sql } from "drizzle-orm";
import {
  organizations,
  oauthClients,
  members,
  groups,
  groupMembers,
  entitlements,
  organizationCapabilities,
  organizationDomains,
  ssoProviders,
  invitations,
  sessions,
} from "../schema/index.ts";
import type { LifecycleStatus } from "../schema/vocabulary.ts";
import { beforeCursor, type PageQuery } from "../../http/pagination.ts";
import { createId } from "../../lib/id.ts";

export type OrganizationInput = {
  slug: string;
  name: string;
  logo?: string;
  metadata?: string;
};
export type OrganizationPatch = {
  name?: string;
  logo?: string | null;
  metadata?: string | null;
};
export type OrganizationQuery = PageQuery & {
  q?: string;
  status?: LifecycleStatus;
};

export function listOrganizations(
  context: PlatformReadContext,
  query: OrganizationQuery,
) {
  const { tx: executor } = requirePlatformReadContext(context);
  return executor
    .select()
    .from(organizations)
    .where(
      and(
        query.q === undefined
          ? undefined
          : or(
              ilike(organizations.name, `%${query.q}%`),
              ilike(organizations.slug, `%${query.q}%`),
            ),
        query.status === undefined
          ? undefined
          : eq(organizations.status, query.status),
        beforeCursor(organizations.id, query.cursor),
      ),
    )
    .orderBy(desc(organizations.id))
    .limit(query.limit + 1);
}

export async function readOrganization(
  context: TenantReadContext<"directory">,
) {
  const { tx, organizationId } = requireTenantDirectoryContext(context);
  const [row] = await tx
    .select()
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  return row ?? null;
}

export async function readOrganizationStatus(
  context: TenantReadContext<"memberAccess">,
) {
  const { tx, organizationId } = requireTenantMemberAccessContext(context);
  const [row] = await tx
    .select({
      id: organizations.id,
      slug: organizations.slug,
      status: organizations.status,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  return row ?? null;
}

export async function organizationExistsForHistory(
  context: TenantReadContext<"history">,
) {
  const { tx, organizationId } = requireTenantHistoryContext(context);
  const [row] = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  return row !== undefined;
}

export function lockOrganizationForCommand(
  context: PlatformWriteContext,
  organizationId: string,
) {
  const { tx } = requirePlatformWriteContext(context);
  return lockOrganization(tx, organizationId);
}

export async function createOrganization(
  context: PlatformWriteContext,
  input: OrganizationInput,
) {
  const { tx: executor } = requirePlatformWriteContext(context);
  const [row] = await executor
    .insert(organizations)
    .values({ ...input, id: createId() })
    .returning();
  return row!;
}

export async function updateOrganization(
  context: PlatformWriteContext,
  id: string,
  patch: OrganizationPatch,
) {
  const { tx: executor } = requirePlatformWriteContext(context);
  const [row] = await executor
    .update(organizations)
    .set(patch)
    .where(eq(organizations.id, id))
    .returning();
  return row ?? null;
}

export async function setOrganizationStatus(
  context: PlatformWriteContext,
  id: string,
  status: LifecycleStatus,
) {
  const { tx: executor } = requirePlatformWriteContext(context);
  const [row] = await executor
    .update(organizations)
    .set({ status, disabledAt: status === "disabled" ? sql`now()` : null })
    .where(eq(organizations.id, id))
    .returning();
  return row ?? null;
}

export async function countOrganizationClients(
  context: PlatformWriteContext,
  id: string,
) {
  const { tx: executor } = requirePlatformWriteContext(context);
  const [row] = await executor
    .select({ count: count() })
    .from(oauthClients)
    .where(eq(oauthClients.organizationId, id));
  return row!.count;
}

/** Delete children explicitly so erasure evidence comes from actual removed rows.
 * Caller holds the organisation lock and removes grant contexts first.
 * Return only policy/identity fields; provider credentials and invitation email stay out.
 */
export async function deleteOrganization(
  context: PlatformWriteContext,
  organizationId: string,
) {
  const { tx } = requirePlatformWriteContext(context);
  const removedEntitlements = await tx
    .delete(entitlements)
    .where(eq(entitlements.organizationId, organizationId))
    .returning({
      id: entitlements.id,
      organizationId: entitlements.organizationId,
      revision: entitlements.revision,
      memberId: entitlements.memberId,
      groupId: entitlements.groupId,
      clientId: entitlements.clientId,
      resource: entitlements.resource,
      scopes: entitlements.scopes,
      status: entitlements.status,
      validFrom: entitlements.validFrom,
      validUntil: entitlements.validUntil,
    });
  const removedAssignments = await tx
    .delete(groupMembers)
    .where(eq(groupMembers.organizationId, organizationId))
    .returning({
      id: groupMembers.id,
      organizationId: groupMembers.organizationId,
      revision: groupMembers.revision,
      memberId: groupMembers.memberId,
      groupId: groupMembers.groupId,
      validFrom: groupMembers.validFrom,
      validUntil: groupMembers.validUntil,
    });
  const removedMembers = await tx
    .delete(members)
    .where(eq(members.organizationId, organizationId))
    .returning({
      id: members.id,
      organizationId: members.organizationId,
      userId: members.userId,
      revision: members.revision,
      status: members.status,
      revokedAt: members.revokedAt,
      validFrom: members.validFrom,
      validUntil: members.validUntil,
    });
  const removedGroups = await tx
    .delete(groups)
    .where(eq(groups.organizationId, organizationId))
    .returning({
      id: groups.id,
      organizationId: groups.organizationId,
      revision: groups.revision,
      slug: groups.slug,
      status: groups.status,
    });
  const removedCapabilities = await tx
    .delete(organizationCapabilities)
    .where(eq(organizationCapabilities.organizationId, organizationId))
    .returning({
      id: organizationCapabilities.id,
      organizationId: organizationCapabilities.organizationId,
      revision: organizationCapabilities.revision,
      clientId: organizationCapabilities.clientId,
      resource: organizationCapabilities.resource,
      grantKind: organizationCapabilities.grantKind,
      scopes: organizationCapabilities.scopes,
      status: organizationCapabilities.status,
      validFrom: organizationCapabilities.validFrom,
      validUntil: organizationCapabilities.validUntil,
    });
  const removedDomains = await tx
    .delete(organizationDomains)
    .where(eq(organizationDomains.organizationId, organizationId))
    .returning({
      id: organizationDomains.id,
      organizationId: organizationDomains.organizationId,
      domain: organizationDomains.domain,
      status: organizationDomains.status,
    });
  const removedSsoProviders = await tx
    .delete(ssoProviders)
    .where(eq(ssoProviders.organizationId, organizationId))
    .returning({
      id: ssoProviders.id,
      organizationId: ssoProviders.organizationId,
      revision: ssoProviders.revision,
      providerId: ssoProviders.providerId,
      issuer: ssoProviders.issuer,
      domain: ssoProviders.domain,
    });
  const removedInvitations = await tx
    .delete(invitations)
    .where(eq(invitations.organizationId, organizationId))
    .returning({
      id: invitations.id,
      organizationId: invitations.organizationId,
      status: invitations.status,
      expiresAt: invitations.expiresAt,
    });
  // This mirrors the FK's SET NULL effect; browser sessions are not revoked.
  const clearedSessionSelections = await tx
    .update(sessions)
    .set({ activeOrganizationId: null, updatedAt: sql`${sessions.updatedAt}` })
    .where(eq(sessions.activeOrganizationId, organizationId))
    .returning({
      id: sessions.id,
      userId: sessions.userId,
      organizationId: sql<string>`${organizationId}::uuid`,
    });
  await tx.delete(organizations).where(eq(organizations.id, organizationId));
  return {
    removedEntitlements,
    removedAssignments,
    removedMembers,
    removedGroups,
    removedCapabilities,
    removedDomains,
    removedSsoProviders,
    removedInvitations,
    clearedSessionSelections,
  };
}
