import { withDatabaseScope } from "../db/isolation.ts";
import { and, eq, isNull, sql } from "drizzle-orm";
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

/** Caller holds the grant's ordered authority locks. Renewal relies on the grant's
 * authentication evidence after browser sign-out; administrative revocation is a
 * separate barrier.
 */
export async function currentGrantAuthentication(
  executor: Executor,
  grant: typeof grantContexts.$inferSelect,
) {
  return withDatabaseScope(executor, { kind: "protocol" }, async (tx) => {
    await tx
      .select({ id: ssoProviders.id })
      .from(ssoProviders)
      .where(eq(ssoProviders.id, grant.authenticationProviderId))
      .for("share");
    await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.id, grant.authenticationAccountId))
      .for("share");
    const [current] = await tx
      .select({ id: members.id })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .innerJoin(organizations, eq(organizations.id, members.organizationId))
      .innerJoin(
        ssoProviders,
        and(
          eq(ssoProviders.id, grant.authenticationProviderId),
          eq(ssoProviders.organizationId, organizations.id),
          eq(ssoProviders.revision, grant.authenticationProviderRevision),
        ),
      )
      .innerJoin(
        accounts,
        and(
          eq(accounts.id, grant.authenticationAccountId),
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
    return current !== undefined && grant.revokedAt === null;
  });
}
