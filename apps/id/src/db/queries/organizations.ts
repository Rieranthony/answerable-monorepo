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
        sql`${organizations.deletedAt} is null`,
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
    .where(
      and(
        sql`${organizations.deletedAt} is null`,
        eq(organizations.id, organizationId),
      ),
    );
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
    .where(
      and(
        sql`${organizations.deletedAt} is null`,
        eq(organizations.id, organizationId),
      ),
    );
  return row ?? null;
}

export async function organizationExistsForHistory(
  context: TenantReadContext<"history">,
) {
  const { tx, organizationId } = requireTenantHistoryContext(context);
  const [row] = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(
      and(
        sql`${organizations.deletedAt} is null`,
        eq(organizations.id, organizationId),
      ),
    );
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
    .where(
      and(sql`${organizations.deletedAt} is null`, eq(organizations.id, id)),
    )
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
    .where(
      and(sql`${organizations.deletedAt} is null`, eq(organizations.id, id)),
    )
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
    .where(
      and(
        sql`${oauthClients.deletedAt} is null`,
        eq(oauthClients.organizationId, id),
      ),
    );
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
  const softDeletedEntitlements = await tx
    .update(entitlements)
    .set({ deletedAt: sql`now()`, status: "disabled" })
    .where(
      and(
        sql`${entitlements.deletedAt} is null`,
        eq(entitlements.organizationId, organizationId),
      ),
    )
    .returning({
      deletedAt: entitlements.deletedAt,
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
  const softDeletedAssignments = await tx
    .update(groupMembers)
    .set({ deletedAt: sql`now()` })
    .where(
      and(
        sql`${groupMembers.deletedAt} is null`,
        eq(groupMembers.organizationId, organizationId),
      ),
    )
    .returning({
      deletedAt: groupMembers.deletedAt,
      id: groupMembers.id,
      organizationId: groupMembers.organizationId,
      revision: groupMembers.revision,
      memberId: groupMembers.memberId,
      groupId: groupMembers.groupId,
      validFrom: groupMembers.validFrom,
      validUntil: groupMembers.validUntil,
    });
  const softDeletedMembers = await tx
    .update(members)
    .set({
      deletedAt: sql`now()`,
      status: "revoked",
      revokedAt: sql`coalesce(${members.revokedAt}, now())`,
    })
    .where(
      and(
        sql`${members.deletedAt} is null`,
        eq(members.organizationId, organizationId),
      ),
    )
    .returning({
      deletedAt: members.deletedAt,
      id: members.id,
      organizationId: members.organizationId,
      userId: members.userId,
      revision: members.revision,
      status: members.status,
      revokedAt: members.revokedAt,
      validFrom: members.validFrom,
      validUntil: members.validUntil,
    });
  const softDeletedGroups = await tx
    .update(groups)
    .set({ deletedAt: sql`now()`, status: "disabled" })
    .where(
      and(
        sql`${groups.deletedAt} is null`,
        eq(groups.organizationId, organizationId),
      ),
    )
    .returning({
      deletedAt: groups.deletedAt,
      id: groups.id,
      organizationId: groups.organizationId,
      revision: groups.revision,
      slug: groups.slug,
      status: groups.status,
    });
  const softDeletedCapabilities = await tx
    .update(organizationCapabilities)
    .set({ deletedAt: sql`now()`, status: "disabled" })
    .where(
      and(
        sql`${organizationCapabilities.deletedAt} is null`,
        eq(organizationCapabilities.organizationId, organizationId),
      ),
    )
    .returning({
      deletedAt: organizationCapabilities.deletedAt,
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
  const softDeletedDomains = await tx
    .update(organizationDomains)
    .set({ deletedAt: sql`now()`, status: "disabled" })
    .where(
      and(
        sql`${organizationDomains.deletedAt} is null`,
        eq(organizationDomains.organizationId, organizationId),
      ),
    )
    .returning({
      deletedAt: organizationDomains.deletedAt,
      id: organizationDomains.id,
      organizationId: organizationDomains.organizationId,
      domain: organizationDomains.domain,
      status: organizationDomains.status,
    });
  const softDeletedSsoProviders = await tx
    .update(ssoProviders)
    .set({ deletedAt: sql`now()`, oidcConfig: null, samlConfig: null })
    .where(
      and(
        sql`${ssoProviders.deletedAt} is null`,
        eq(ssoProviders.organizationId, organizationId),
      ),
    )
    .returning({
      deletedAt: ssoProviders.deletedAt,
      id: ssoProviders.id,
      organizationId: ssoProviders.organizationId,
      revision: ssoProviders.revision,
      providerId: ssoProviders.providerId,
      issuer: ssoProviders.issuer,
      domain: ssoProviders.domain,
    });
  const softDeletedInvitations = await tx
    .update(invitations)
    .set({ deletedAt: sql`now()`, status: "canceled" })
    .where(
      and(
        sql`${invitations.deletedAt} is null`,
        eq(invitations.organizationId, organizationId),
      ),
    )
    .returning({
      deletedAt: invitations.deletedAt,
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
  const [row] = await tx
    .update(organizations)
    .set({ deletedAt: sql`now()`, status: "disabled", disabledAt: sql`now()` })
    .where(
      and(
        sql`${organizations.deletedAt} is null`,
        eq(organizations.id, organizationId),
      ),
    )
    .returning();
  return {
    row: row!,
    effects: {
      softDeletedEntitlements,
      softDeletedAssignments,
      softDeletedMembers,
      softDeletedGroups,
      softDeletedCapabilities,
      softDeletedDomains,
      softDeletedSsoProviders,
      softDeletedInvitations,
      clearedSessionSelections,
    },
  };
}
