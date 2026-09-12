import { revokeUserAndOwnedClientGrantContexts } from "./grant-contexts.ts";
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
        sql`${users.deletedAt} is null`,
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
        sql`${users.deletedAt} is null`,
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
                    sql`${members.deletedAt} is null`,
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
    .where(and(sql`${users.deletedAt} is null`, eq(users.id, userId)))
    .for("update");
  await context.revalidate();
  return row ?? null;
}

/** Existence checks must not load the user's profile and identity graph. */
export async function userExists(context: PlatformReadContext, userId: string) {
  const { tx: executor } = requirePlatformReadContext(context);
  const rows = await executor
    .select({ id: users.id })
    .from(users)
    .where(and(sql`${users.deletedAt} is null`, eq(users.id, userId)));
  return rows.length > 0;
}

export async function findUser(context: PlatformReadContext, userId: string) {
  const { tx: executor } = requirePlatformReadContext(context);
  const [row] = await executor
    .select()
    .from(users)
    .where(and(sql`${users.deletedAt} is null`, eq(users.id, userId)));
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
    .where(
      and(
        sql`${organizations.deletedAt} is null`,
        sql`${members.deletedAt} is null`,
        eq(members.userId, userId),
      ),
    )
    .orderBy(desc(members.id));
  const identities = await executor
    .select({
      issuer: accounts.issuer,
      providerId: accounts.providerId,
      directoryId: accounts.directoryId,
      directoryUserId: accounts.directoryUserId,
    })
    .from(accounts)
    .where(and(sql`${accounts.deletedAt} is null`, eq(accounts.userId, userId)))
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
    .where(and(sql`${users.deletedAt} is null`, eq(users.id, userId)))
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
            .where(
              and(
                sql`${oauthClients.deletedAt} is null`,
                eq(oauthClients.userId, userId),
              ),
            ),
        ),
      ),
    )
    .orderBy(oauthRefreshTokens.id)
    .for("update");
  const revokedGrantContexts = await revokeUserAndOwnedClientGrantContexts(
    context,
    userId,
  );
  const membershipIds = tx
    .select({ id: members.id })
    .from(members)
    .where(and(sql`${members.deletedAt} is null`, eq(members.userId, userId)));
  const ownedClientIds = tx
    .select({ clientId: oauthClients.clientId })
    .from(oauthClients)
    .where(
      and(
        sql`${oauthClients.deletedAt} is null`,
        eq(oauthClients.userId, userId),
      ),
    );
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
  const softDeletedConsents = await tx
    .update(oauthConsents)
    .set({ deletedAt: sql`now()` })
    .where(
      and(
        sql`${oauthConsents.deletedAt} is null`,
        or(
          eq(oauthConsents.userId, userId),
          inArray(oauthConsents.clientId, ownedClientIds),
        ),
      ),
    )
    .returning({
      deletedAt: oauthConsents.deletedAt,
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
  const softDeletedEntitlements = await tx
    .update(entitlements)
    .set({ deletedAt: sql`now()`, status: "disabled" })
    .where(
      and(
        sql`${entitlements.deletedAt} is null`,
        inArray(entitlements.memberId, membershipIds),
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
        inArray(groupMembers.memberId, membershipIds),
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
    .where(and(sql`${members.deletedAt} is null`, eq(members.userId, userId)))
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
  const softDeletedClientResources = await tx
    .update(oauthClientResources)
    .set({ deletedAt: sql`now()` })
    .where(
      and(
        sql`${oauthClientResources.deletedAt} is null`,
        inArray(oauthClientResources.clientId, ownedClientIds),
      ),
    )
    .returning({
      deletedAt: oauthClientResources.deletedAt,
      id: oauthClientResources.id,
      clientId: oauthClientResources.clientId,
      resourceId: oauthClientResources.resourceId,
    });
  const softDeletedClients = await tx
    .update(oauthClients)
    .set({ deletedAt: sql`now()`, disabled: true, clientSecret: null })
    .where(
      and(
        sql`${oauthClients.deletedAt} is null`,
        eq(oauthClients.userId, userId),
      ),
    )
    .returning({
      deletedAt: oauthClients.deletedAt,
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
  const softDeletedAccounts = await tx
    .update(accounts)
    .set({
      deletedAt: sql`now()`,
      accessToken: null,
      refreshToken: null,
      idToken: null,
      password: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
    })
    .where(and(sql`${accounts.deletedAt} is null`, eq(accounts.userId, userId)))
    .returning({
      deletedAt: accounts.deletedAt,
      id: accounts.id,
      userId: accounts.userId,
    });
  const softDeletedInvitations = await tx
    .update(invitations)
    .set({ deletedAt: sql`now()`, status: "canceled" })
    .where(
      and(
        sql`${invitations.deletedAt} is null`,
        eq(invitations.inviterId, userId),
      ),
    )
    .returning({
      deletedAt: invitations.deletedAt,
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
    .where(
      and(
        sql`${ssoProviders.deletedAt} is null`,
        eq(ssoProviders.userId, userId),
      ),
    )
    .orderBy(ssoProviders.id)
    .for("update");
  const providers = await tx
    .update(ssoProviders)
    .set({ userId: null, updatedAt: sql`${ssoProviders.updatedAt}` })
    .where(
      and(
        sql`${ssoProviders.deletedAt} is null`,
        eq(ssoProviders.userId, userId),
      ),
    )
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
    .update(users)
    .set({
      deletedAt: sql`now()`,
      status: "disabled",
      disabledAt: sql`now()`,
      retiredEmail: sql`coalesce(${users.retiredEmail}, ${users.email})`,
      email: sql`${users.id}::text || '@retired.invalid'`,
    })
    .where(and(sql`${users.deletedAt} is null`, eq(users.id, userId)))
    .returning();
  return row
    ? {
        ...row,
        revokedGrantContexts,
        effects: {
          deletedAccessTokens,
          deletedRefreshTokens,
          softDeletedConsents,
          clearedAccessTokenSessions,
          clearedRefreshTokenSessions,
          softDeletedEntitlements,
          softDeletedAssignments,
          softDeletedMembers,
          softDeletedClientResources,
          softDeletedClients,
          deletedSessions,
          softDeletedAccounts,
          softDeletedInvitations,
          detachedSsoProviders,
        },
      }
    : null;
}
