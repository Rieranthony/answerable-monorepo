import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Executor } from "../db/client.ts";
import {
  accounts,
  grantContexts,
  members,
  organizations,
  ssoProviders,
  users,
} from "../db/schema/index.ts";
import { isEffective } from "../db/queries/effective.ts";
import type { TenantAuthentication } from "./tenant-authentication.ts";

export const grantAuthenticationSchema = z.object({
  userId: z.uuid(),
  memberId: z.uuid(),
  authenticationSessionId: z.uuid(),
  authenticationAccountId: z.uuid(),
  authenticationOrganizationId: z.uuid(),
  authenticationProviderId: z.uuid(),
  authenticationProviderRevision: z.number().int().positive(),
  brokerAuthenticatedAt: z.iso.datetime(),
  upstreamAuthTime: z.iso.datetime().nullable(),
  sessionExpiresAt: z.iso.datetime(),
});
export type GrantAuthentication = z.infer<typeof grantAuthenticationSchema>;

export function grantAuthenticationSnapshot(
  value: TenantAuthentication,
): GrantAuthentication {
  return {
    ...value,
    brokerAuthenticatedAt: value.brokerAuthenticatedAt.toISOString(),
    upstreamAuthTime: value.upstreamAuthTime?.toISOString() ?? null,
    sessionExpiresAt: value.sessionExpiresAt.toISOString(),
  };
}

/** Caller holds the grant's ordered authority locks. Renewal retains authentication
 * evidence after browser sign-out; administrative revocation is a separate barrier.
 */
export async function currentGrantAuthentication(
  tx: Executor,
  grant: typeof grantContexts.$inferSelect,
) {
  const parsed = grantAuthenticationSchema.safeParse(grant.authentication);
  if (!parsed.success) return null;
  const evidence = parsed.data;
  if (
    evidence.userId !== grant.userId ||
    evidence.memberId !== grant.memberId ||
    evidence.authenticationOrganizationId !== grant.organizationId ||
    evidence.authenticationSessionId !== grant.authenticationSessionId ||
    new Date(evidence.brokerAuthenticatedAt).getTime() !==
      grant.authTime.getTime()
  )
    return null;
  await tx
    .select({ id: ssoProviders.id })
    .from(ssoProviders)
    .where(eq(ssoProviders.id, evidence.authenticationProviderId))
    .for("share");
  await tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.id, evidence.authenticationAccountId))
    .for("share");
  const [current] = await tx
    .select({ id: members.id })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .innerJoin(organizations, eq(organizations.id, members.organizationId))
    .innerJoin(
      ssoProviders,
      and(
        eq(ssoProviders.id, evidence.authenticationProviderId),
        eq(ssoProviders.organizationId, organizations.id),
        eq(ssoProviders.revision, evidence.authenticationProviderRevision),
      ),
    )
    .innerJoin(
      accounts,
      and(
        eq(accounts.id, evidence.authenticationAccountId),
        eq(accounts.userId, users.id),
        eq(accounts.issuer, ssoProviders.issuer),
        eq(accounts.providerId, ssoProviders.providerId),
      ),
    )
    .where(
      and(
        eq(members.id, grant.memberId),
        eq(users.id, grant.userId),
        eq(organizations.id, grant.organizationId),
        isEffective(members),
        eq(users.status, "active"),
        eq(organizations.status, "active"),
        isNull(users.deletedAt),
        isNull(organizations.deletedAt),
        isNull(accounts.deletedAt),
        isNull(ssoProviders.deletedAt),
        sql`${grant.expiresAt} > statement_timestamp()`,
      ),
    );
  return current && grant.revokedAt === null ? evidence : null;
}
