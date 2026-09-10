import { deleteUserGrantContexts } from "./grant-contexts.ts";
import {
  requirePlatformReadContext,
  requirePlatformUsersContext,
  requirePlatformWriteContext,
  type PlatformReadContext,
  type PlatformUsersContext,
  type PlatformWriteContext,
} from "../../services/platform-context.ts";
import {
  and,
  count,
  desc,
  eq,
  exists,
  ilike,
  inArray,
  isNull,
  or,
  sql,
} from "drizzle-orm";

import {
  users,
  members,
  organizations,
  accounts,
  sessions,
  groupMembers,
  entitlements,
  invitations,
  ssoProviders,
  oauthClients,
  oauthClientResources,
  oauthAccessTokens,
  oauthRefreshTokens,
  oauthConsents,
} from "../schema/index.ts";

export class UserNotRetirableError extends Error {
  constructor(userId: string) {
    super(`User cannot be retired: ${userId}`);
    this.name = "UserNotRetirableError";
  }
}

export function retiredEmailFor(userId: string): string {
  return `${userId}@retired.invalid`;
}

export async function retireUserEmail(
  context: PlatformUsersContext,
  userId: string,
) {
  const { tx: db } = requirePlatformUsersContext(context);
  const [user] = await db
    .update(users)
    .set({
      retiredEmail: users.email,
      email: sql`${users.id}::text || '@retired.invalid'`,
    })
    .where(
      and(
        eq(users.id, userId),
        eq(users.status, "disabled"),
        isNull(users.retiredEmail),
      ),
    )
    .returning();

  if (!user) throw new UserNotRetirableError(userId);

  return user;
}

import { beforeCursor, type PageQuery } from "../../http/pagination.ts";
import { isEffective } from "./effective.ts";

export type UserQuery = PageQuery & {
  q?: string;
  email?: string;
  status?: typeof users.$inferSelect.status;
  organizationId?: string;
};

export function listUsers(context: PlatformReadContext, query: UserQuery) {
  const { tx: executor } = requirePlatformReadContext(context);
  return executor
    .select()
    .from(users)
    .where(
      and(
        query.email === undefined
          ? undefined
          : eq(users.email, query.email.toLowerCase()),
        query.q === undefined
          ? undefined
          : or(
              ilike(users.email, `%${query.q}%`),
              ilike(users.name, `%${query.q}%`),
            ),
        query.status === undefined ? undefined : eq(users.status, query.status),
        query.organizationId === undefined
          ? undefined
          : exists(
              executor
                .select({ id: members.id })
                .from(members)
                .where(
                  and(
                    eq(members.userId, users.id),
                    eq(members.organizationId, query.organizationId),
                  ),
                ),
            ),
        beforeCursor(users.id, query.cursor),
      ),
    )
    .orderBy(desc(users.id))
    .limit(query.limit + 1);
}

export async function lockUser(
  context: PlatformUsersContext | PlatformWriteContext,
  userId: string,
) {
  const { tx: executor } =
    context?.access === "write"
      ? requirePlatformWriteContext(context)
      : requirePlatformUsersContext(context);
  const [row] = await executor
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .for("update");
  return row ?? null;
}

/** Existence checks must not load the user's profile and identity graph. */
export async function userExists(context: PlatformReadContext, userId: string) {
  const { tx: executor } = requirePlatformReadContext(context);
  const rows = await executor
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId));
  return rows.length > 0;
}

export async function findUser(context: PlatformReadContext, userId: string) {
  const { tx: executor } = requirePlatformReadContext(context);
  const [row] = await executor.select().from(users).where(eq(users.id, userId));
  if (!row) return null;
  const memberships = await executor
    .select({
      memberId: members.id,
      organizationId: organizations.id,
      slug: organizations.slug,
      validFrom: members.validFrom,
      validUntil: members.validUntil,
      effective: sql<boolean>`(${isEffective(members)})`,
    })
    .from(members)
    .innerJoin(organizations, eq(organizations.id, members.organizationId))
    .where(eq(members.userId, userId))
    .orderBy(desc(members.id));
  const identities = await executor
    .select({
      issuer: accounts.issuer,
      providerId: accounts.providerId,
      directoryId: accounts.directoryId,
      directoryUserId: accounts.directoryUserId,
    })
    .from(accounts)
    .where(eq(accounts.userId, userId))
    .orderBy(desc(accounts.id));
  const [total] = await executor
    .select({ count: count() })
    .from(sessions)
    .where(eq(sessions.userId, userId));
  return {
    ...row,
    memberships,
    accounts: identities,
    sessionCount: total!.count,
  };
}

export async function setUserStatus(
  context: PlatformUsersContext,
  userId: string,
  status: "active" | "disabled",
) {
  const { tx: executor } = requirePlatformUsersContext(context);
  const [row] = await executor
    .update(users)
    .set({ status, disabledAt: status === "disabled" ? sql`now()` : null })
    .where(eq(users.id, userId))
    .returning();
  return row ?? null;
}

/** Caller holds the user FOR UPDATE. Capture actual cascade effects before
 * deleting their parents, without exposing credential-bearing rows.
 */
export async function deleteUser(
  context: PlatformWriteContext,
  userId: string,
) {
  const { tx } = requirePlatformWriteContext(context);
  // Lock indirect parents before capturing any children, including grants.
  for (const table of [oauthClients, members, sessions] as const) {
    await tx
      .select({ id: table.id })
      .from(table)
      .where(eq(table.userId, userId))
      .orderBy(table.id)
      .for("update");
  }
  await tx
    .select({ id: oauthRefreshTokens.id })
    .from(oauthRefreshTokens)
    .where(
      or(
        eq(oauthRefreshTokens.userId, userId),
        inArray(
          oauthRefreshTokens.clientId,
          tx
            .select({ clientId: oauthClients.clientId })
            .from(oauthClients)
            .where(eq(oauthClients.userId, userId)),
        ),
      ),
    )
    .orderBy(oauthRefreshTokens.id)
    .for("update");
  const deletedGrantContexts = await deleteUserGrantContexts(context, userId);
  const membershipIds = tx
    .select({ id: members.id })
    .from(members)
    .where(eq(members.userId, userId));
  const ownedClientIds = tx
    .select({ clientId: oauthClients.clientId })
    .from(oauthClients)
    .where(eq(oauthClients.userId, userId));
  const refreshWhere = or(
    eq(oauthRefreshTokens.userId, userId),
    inArray(oauthRefreshTokens.clientId, ownedClientIds),
  );
  const erasedRefreshIds = tx
    .select({ id: oauthRefreshTokens.id })
    .from(oauthRefreshTokens)
    .where(refreshWhere);
  const deletedAccessTokens = await tx
    .delete(oauthAccessTokens)
    .where(
      or(
        eq(oauthAccessTokens.userId, userId),
        inArray(oauthAccessTokens.clientId, ownedClientIds),
        inArray(oauthAccessTokens.refreshId, erasedRefreshIds),
      ),
    )
    .returning({
      id: oauthAccessTokens.id,
      userId: oauthAccessTokens.userId,
      clientId: oauthAccessTokens.clientId,
      sessionId: oauthAccessTokens.sessionId,
      refreshId: oauthAccessTokens.refreshId,
      scopes: oauthAccessTokens.scopes,
      resources: oauthAccessTokens.resources,
      expiresAt: oauthAccessTokens.expiresAt,
      revoked: oauthAccessTokens.revoked,
    });
  const deletedRefreshTokens = await tx
    .delete(oauthRefreshTokens)
    .where(refreshWhere)
    .returning({
      id: oauthRefreshTokens.id,
      userId: oauthRefreshTokens.userId,
      clientId: oauthRefreshTokens.clientId,
      sessionId: oauthRefreshTokens.sessionId,
      scopes: oauthRefreshTokens.scopes,
      resources: oauthRefreshTokens.resources,
      expiresAt: oauthRefreshTokens.expiresAt,
      revoked: oauthRefreshTokens.revoked,
    });
  const deletedConsents = await tx
    .delete(oauthConsents)
    .where(
      or(
        eq(oauthConsents.userId, userId),
        inArray(oauthConsents.clientId, ownedClientIds),
      ),
    )
    .returning({
      id: oauthConsents.id,
      userId: oauthConsents.userId,
      clientId: oauthConsents.clientId,
      scopes: oauthConsents.scopes,
      resources: oauthConsents.resources,
    });
  const clearedAccessTokenSessions = await tx
    .update(oauthAccessTokens)
    .set({ sessionId: null })
    .from(sessions)
    .where(
      and(
        eq(oauthAccessTokens.sessionId, sessions.id),
        eq(sessions.userId, userId),
      ),
    )
    .returning({
      id: oauthAccessTokens.id,
      userId: oauthAccessTokens.userId,
      clientId: oauthAccessTokens.clientId,
      beforeSessionId: sessions.id,
      afterSessionId: oauthAccessTokens.sessionId,
    });
  const clearedRefreshTokenSessions = await tx
    .update(oauthRefreshTokens)
    .set({ sessionId: null })
    .from(sessions)
    .where(
      and(
        eq(oauthRefreshTokens.sessionId, sessions.id),
        eq(sessions.userId, userId),
      ),
    )
    .returning({
      id: oauthRefreshTokens.id,
      userId: oauthRefreshTokens.userId,
      clientId: oauthRefreshTokens.clientId,
      beforeSessionId: sessions.id,
      afterSessionId: oauthRefreshTokens.sessionId,
    });
  const removedEntitlements = await tx
    .delete(entitlements)
    .where(inArray(entitlements.memberId, membershipIds))
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
    .where(inArray(groupMembers.memberId, membershipIds))
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
    .where(eq(members.userId, userId))
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
  const deletedClientResources = await tx
    .delete(oauthClientResources)
    .where(inArray(oauthClientResources.clientId, ownedClientIds))
    .returning({
      id: oauthClientResources.id,
      clientId: oauthClientResources.clientId,
      resourceId: oauthClientResources.resourceId,
    });
  const deletedClients = await tx
    .delete(oauthClients)
    .where(eq(oauthClients.userId, userId))
    .returning({
      id: oauthClients.id,
      clientId: oauthClients.clientId,
      userId: oauthClients.userId,
      organizationId: oauthClients.organizationId,
      revision: oauthClients.revision,
      authorizationVersion: oauthClients.authorizationVersion,
      disabled: oauthClients.disabled,
      scopes: oauthClients.scopes,
      clientCredentialsScopes: oauthClients.clientCredentialsScopes,
      grantTypes: oauthClients.grantTypes,
      redirectUris: oauthClients.redirectUris,
      tokenEndpointAuthMethod: oauthClients.tokenEndpointAuthMethod,
      requirePKCE: oauthClients.requirePKCE,
      skipConsent: oauthClients.skipConsent,
    });
  const deletedSessions = await tx
    .delete(sessions)
    .where(eq(sessions.userId, userId))
    .returning({
      id: sessions.id,
      userId: sessions.userId,
      authenticationOrganizationId: sessions.authenticationOrganizationId,
      authenticationProviderId: sessions.authenticationProviderId,
      authenticationProviderRevision: sessions.authenticationProviderRevision,
      createdAt: sessions.createdAt,
      expiresAt: sessions.expiresAt,
    });
  const deletedAccounts = await tx
    .delete(accounts)
    .where(eq(accounts.userId, userId))
    .returning({ id: accounts.id, userId: accounts.userId });
  const deletedInvitations = await tx
    .delete(invitations)
    .where(eq(invitations.inviterId, userId))
    .returning({
      id: invitations.id,
      organizationId: invitations.organizationId,
      status: invitations.status,
      expiresAt: invitations.expiresAt,
    });
  const providerBefore = await tx
    .select({
      id: ssoProviders.id,
      userId: ssoProviders.userId,
      revision: ssoProviders.revision,
    })
    .from(ssoProviders)
    .where(eq(ssoProviders.userId, userId))
    .orderBy(ssoProviders.id)
    .for("update");
  const providers = await tx
    .update(ssoProviders)
    .set({ userId: null, updatedAt: sql`${ssoProviders.updatedAt}` })
    .where(eq(ssoProviders.userId, userId))
    .returning({
      id: ssoProviders.id,
      organizationId: ssoProviders.organizationId,
      userId: ssoProviders.userId,
      revision: ssoProviders.revision,
    });
  const beforeById = new Map(
    providerBefore.map(({ id, ...before }) => [id, before]),
  );
  const detachedSsoProviders = providers.map((row) => {
    const before = beforeById.get(row.id)!;
    return {
      id: row.id,
      organizationId: row.organizationId,
      before: { userId: before.userId, revision: before.revision },
      after: { userId: row.userId, revision: row.revision },
    };
  });
  const [row] = await tx
    .delete(users)
    .where(eq(users.id, userId))
    .returning({ id: users.id });
  return row
    ? {
        ...row,
        deletedGrantContexts,
        effects: {
          deletedAccessTokens,
          deletedRefreshTokens,
          deletedConsents,
          clearedAccessTokenSessions,
          clearedRefreshTokenSessions,
          removedEntitlements,
          removedAssignments,
          removedMembers,
          deletedClientResources,
          deletedClients,
          deletedSessions,
          deletedAccounts,
          deletedInvitations,
          detachedSsoProviders,
        },
      }
    : null;
}
