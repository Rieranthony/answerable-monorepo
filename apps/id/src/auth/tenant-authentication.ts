import { and, eq, isNull, sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { isEffective } from "../db/queries/effective.ts";
import {
  accounts,
  members,
  organizations,
  sessions,
  ssoProviders,
  users,
} from "../db/schema/index.ts";

/** Immutable evidence for subsequent login/resource-grant persistence.
 * Broker acceptance time is not upstream authentication freshness.
 */
export type TenantAuthentication = Readonly<{
  userId: string;
  memberId: string;
  authenticationSessionId: string;
  authenticationAccountId: string;
  authenticationOrganizationId: string;
  authenticationProviderId: string;
  authenticationProviderRevision: number;
  brokerAuthenticatedAt: Date;
  upstreamAuthTime: Date | null;
  sessionExpiresAt: Date;
}>;

/** Trusted callers hold the user and target organisation locks in their existing
 * transaction/scope. Lock native origin rows, then re-read current authority and
 * database time after waits. IDs from an unverified request are not authentication.
 */
export async function tenantAuthentication(
  tx: Executor,
  input: {
    userId: string;
    sessionId: string;
    organizationId: string;
    reauthentication?: true;
  },
): Promise<TenantAuthentication | null> {
  const origin = and(
    eq(sessions.id, input.sessionId),
    eq(sessions.userId, input.userId),
    eq(sessions.authenticationOrganizationId, input.organizationId),
  );
  await tx
    .select({ id: ssoProviders.id })
    .from(sessions)
    .innerJoin(
      ssoProviders,
      eq(ssoProviders.id, sessions.authenticationProviderId),
    )
    .where(origin)
    .for("share", { of: ssoProviders });
  await tx
    .select({ id: accounts.id })
    .from(sessions)
    .innerJoin(accounts, eq(accounts.id, sessions.authenticationAccountId))
    .where(origin)
    .for("share", { of: [accounts, sessions] });
  const [evidence] = await tx
    .select({
      userId: users.id,
      memberId: members.id,
      authenticationSessionId: sessions.id,
      authenticationAccountId: accounts.id,
      authenticationOrganizationId: organizations.id,
      authenticationProviderId: ssoProviders.id,
      authenticationProviderRevision: ssoProviders.revision,
      brokerAuthenticatedAt: sessions.createdAt,
      upstreamAuthTime: sessions.upstreamAuthTime,
      sessionExpiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(
      accounts,
      and(
        eq(accounts.id, sessions.authenticationAccountId),
        eq(accounts.userId, users.id),
      ),
    )
    .innerJoin(
      ssoProviders,
      and(
        eq(ssoProviders.id, sessions.authenticationProviderId),
        input.reauthentication
          ? undefined
          : eq(ssoProviders.revision, sessions.authenticationProviderRevision),
        eq(ssoProviders.issuer, accounts.issuer),
        eq(ssoProviders.providerId, accounts.providerId),
      ),
    )
    .innerJoin(
      organizations,
      and(
        eq(organizations.id, ssoProviders.organizationId),
        eq(organizations.id, sessions.authenticationOrganizationId),
      ),
    )
    .innerJoin(
      members,
      and(
        eq(members.userId, users.id),
        eq(members.organizationId, organizations.id),
      ),
    )
    .where(
      and(
        origin,
        isNull(accounts.deletedAt),
        isNull(ssoProviders.deletedAt),
        isNull(users.deletedAt),
        eq(users.status, "active"),
        isNull(organizations.deletedAt),
        eq(organizations.status, "active"),
        isEffective(members),
        sql`${sessions.expiresAt} > statement_timestamp()`,
      ),
    );
  return evidence ? Object.freeze(evidence) : null;
}
