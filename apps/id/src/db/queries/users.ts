import { revokeErasedUserGrantContexts } from "./grant-contexts.ts";
import { lockUser as lockUserRow } from "../locks.ts";
import type {
  PlatformReadContext,
  PlatformUsersContext,
  PlatformWriteContext,
} from "../../services/platform-context.ts";
import {
  and,
  count,
  desc,
  eq,
  exists,
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
  oauthAccessTokens,
  oauthRefreshTokens,
  oauthConsents,
} from "../schema/index.ts";
import type { PageQuery } from "../../http/pagination.ts";
import { beforeCursor, cursorPage, optionalEq, contains } from "./lists.ts";
import { isEffective } from "./effective.ts";

export function retiredEmailFor(userId: string): string {
  return `${userId}@retired.invalid`;
}

/** The caller has locked the user and checked it is disabled and unretired. */
export async function retireUserEmail(
  context: PlatformUsersContext,
  userId: string,
) {
  const { tx: db } = context;
  const [user] = await db
    .update(users)
    .set({
      retiredEmail: users.email,
      email: sql`${users.id}::text || '@retired.invalid'`,
    })
    .where(
      and(
        isNull(users.deletedAt),
        eq(users.id, userId),
        eq(users.status, "disabled"),
        isNull(users.retiredEmail),
      ),
    )
    .returning();
  return user!;
}

export type UserQuery = PageQuery & {
  q?: string;
  email?: string;
  status?: typeof users.$inferSelect.status;
  organizationId?: string;
};

export async function listUsers(
  context: PlatformReadContext,
  query: UserQuery,
) {
  const { tx: executor } = context;
  return cursorPage(
    await executor
      .select()
      .from(users)
      .where(
        and(
          isNull(users.deletedAt),
          optionalEq(users.email, query.email?.toLowerCase()),
          contains(query.q, users.email, users.name),
          optionalEq(users.status, query.status),
          query.organizationId === undefined
            ? undefined
            : exists(
                executor
                  .select({ id: members.id })
                  .from(members)
                  .where(
                    and(
                      isNull(members.deletedAt),
                      eq(members.userId, users.id),
                      eq(members.organizationId, query.organizationId),
                    ),
                  ),
              ),
          beforeCursor(users.id, query.cursor),
        ),
      )
      .orderBy(desc(users.id))
      .limit(query.limit + 1),
    query.limit,
  );
}

export async function lockUser(
  context: PlatformUsersContext | PlatformWriteContext,
  userId: string,
) {
  const { tx: executor } = context;
  const row = await lockUserRow(executor, userId);
  await context.revalidate();
  return row;
}

/** Existence checks must not load the user's profile and identity graph. */
export async function userExists(context: PlatformReadContext, userId: string) {
  const { tx: executor } = context;
  const rows = await executor
    .select({ id: users.id })
    .from(users)
    .where(and(isNull(users.deletedAt), eq(users.id, userId)));
  return rows.length > 0;
}

export async function findUser(context: PlatformReadContext, userId: string) {
  const { tx: executor } = context;
  const [row] = await executor
    .select()
    .from(users)
    .where(and(isNull(users.deletedAt), eq(users.id, userId)));
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
    .where(and(isNull(members.deletedAt), eq(members.userId, userId)))
    .orderBy(desc(members.id));
  const identities = await executor
    .select({
      issuer: accounts.issuer,
      providerId: accounts.providerId,
      directoryId: accounts.directoryId,
      directoryUserId: accounts.directoryUserId,
    })
    .from(accounts)
    .where(and(isNull(accounts.deletedAt), eq(accounts.userId, userId)))
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
  const { tx: executor } = context;
  const [row] = await executor
    .update(users)
    .set({ status, disabledAt: status === "disabled" ? sql`now()` : null })
    .where(and(isNull(users.deletedAt), eq(users.id, userId)))
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
  const { tx } = context;
  // Lock indirect parents before capturing any children, including grants.
  for (const table of [members, sessions, oauthRefreshTokens] as const) {
    await tx
      .select({ id: table.id })
      .from(table)
      .where(eq(table.userId, userId))
      .orderBy(table.id)
      .for("update");
  }
  const revokedGrantContexts = await revokeErasedUserGrantContexts(
    context,
    userId,
  );
  const membershipIds = tx
    .select({ id: members.id })
    .from(members)
    .where(and(isNull(members.deletedAt), eq(members.userId, userId)));
  const refreshWhere = eq(oauthRefreshTokens.userId, userId);
  const erasedRefreshIds = tx
    .select({ id: oauthRefreshTokens.id })
    .from(oauthRefreshTokens)
    .where(refreshWhere);
  const deletedAccessTokens = await tx
    .delete(oauthAccessTokens)
    .where(
      or(
        eq(oauthAccessTokens.userId, userId),
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
      and(isNull(oauthConsents.deletedAt), eq(oauthConsents.userId, userId)),
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
        isNull(entitlements.deletedAt),
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
        isNull(groupMembers.deletedAt),
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
    .where(and(isNull(members.deletedAt), eq(members.userId, userId)))
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
    .where(and(isNull(accounts.deletedAt), eq(accounts.userId, userId)))
    .returning({
      deletedAt: accounts.deletedAt,
      id: accounts.id,
      userId: accounts.userId,
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
    .where(and(isNull(users.deletedAt), eq(users.id, userId)))
    .returning();
  // The caller has locked this live user, so the update returns its row.
  return {
    ...row!,
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
      deletedSessions,
      softDeletedAccounts,
    },
  };
}
