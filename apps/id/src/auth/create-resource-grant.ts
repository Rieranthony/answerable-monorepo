import { withDatabaseScope } from "../db/isolation.ts";
import { and, eq, or, sql } from "drizzle-orm";
import { APIError } from "better-auth/api";
import type { Executor } from "../db/client.ts";
import { isEffective } from "../db/queries/effective.ts";
import {
  grantContexts,
  members,
  organizations,
  users,
  sessions,
  oauthClients,
  oauthResources,
  oauthClientResources,
} from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";
import { lockResourceGrantTargets } from "./lock-resource-grant-policy.ts";
import { rethrowGrantError } from "./grant-error.ts";
import { tenantAuthentication } from "./tenant-authentication.ts";
import { grantAuthenticationSnapshot } from "./grant-authentication.ts";

/** Native callback supplies authenticated identity/session and validated request scopes.
 * This validates stored provenance; knowing these IDs is not authentication.
 * Lifetime comes from server configuration, never an OAuth request.
 */
export async function createResourceGrant(
  tx: Executor,
  input: {
    userId: string;
    sessionId: string;
    memberId: string;
    clientId: string;
    resource: string | null;
    scopes: readonly string[];
  },
  lifetimeSeconds: number,
) {
  if (!Number.isSafeInteger(lifetimeSeconds) || lifetimeSeconds <= 0)
    throw new TypeError("Grant lifetime must be a positive integer in seconds");
  const scopes = [...new Set(input.scopes)].sort();
  const scopeArray = sql<string[]>`ARRAY[${sql.join(
    scopes.map((scope) => sql`${scope}`),
    sql`, `,
  )}]::text[]`;
  return withDatabaseScope(
    tx,
    {
      kind: "grant-admission",
      userId: input.userId,
      sessionId: input.sessionId,
    },
    async (tx) => {
      // Resolve immutable ownership first; admission is re-read after acquiring locks.
      const [target] = await tx
        .select({
          userId: members.userId,
          organizationId: members.organizationId,
          ownerUserId: oauthClients.userId,
          clientId: oauthClients.clientId,
          resource: oauthResources.identifier,
        })
        .from(members)
        .innerJoin(oauthClients, eq(oauthClients.clientId, input.clientId))
        .leftJoin(
          oauthResources,
          input.resource === null
            ? sql`false`
            : eq(oauthResources.identifier, input.resource),
        )
        .where(
          and(eq(members.id, input.memberId), eq(members.userId, input.userId)),
        );
      if (!target) throw new APIError("FORBIDDEN", { error: "access_denied" });
      await lockResourceGrantTargets(tx, target);
      const authentication = await tenantAuthentication(tx, {
        userId: input.userId,
        sessionId: input.sessionId,
        organizationId: target.organizationId,
      });
      if (!authentication || authentication.memberId !== input.memberId)
        throw new APIError("FORBIDDEN", { error: "access_denied" });
      const [row] = await tx
        .insert(grantContexts)
        .select(
          tx
            .select({
              id: sql<string>`${createId()}::uuid`.as("id"),
              organizationId: members.organizationId,
              memberId: members.id,
              userId: users.id,
              clientInstanceId: oauthClients.id,
              resourceInstanceId: oauthResources.id,
              authorizationCodeId: sql<null>`null`.as("authorization_code_id"),
              authenticationSessionId: sessions.id,
              // Existing context column records broker session creation only.
              // T2 persists the complete authentication snapshot for user OAuth.
              authTime: sessions.createdAt,
              authentication: sql<
                ReturnType<typeof grantAuthenticationSnapshot>
              >`${JSON.stringify(grantAuthenticationSnapshot(authentication))}::jsonb`.as(
                "authentication",
              ),
              requestedScopes: scopeArray.as("requested_scopes"),
              createdAt: sql<Date>`statement_timestamp()`.as("created_at"),
              expiresAt:
                sql<Date>`statement_timestamp() + (${lifetimeSeconds} * interval '1 second')`.as(
                  "expires_at",
                ),
              revokedAt: sql<null>`null`.as("revoked_at"),
            })
            .from(members)
            .innerJoin(users, eq(users.id, members.userId))
            .innerJoin(
              organizations,
              eq(organizations.id, members.organizationId),
            )
            .innerJoin(
              sessions,
              and(
                eq(sessions.userId, users.id),
                eq(sessions.id, input.sessionId),
              ),
            )
            .innerJoin(oauthClients, eq(oauthClients.clientId, input.clientId))
            .leftJoin(
              oauthResources,
              input.resource === null
                ? sql`false`
                : eq(oauthResources.identifier, input.resource),
            )
            .leftJoin(
              oauthClientResources,
              and(
                eq(oauthClientResources.clientId, oauthClients.clientId),
                eq(oauthClientResources.resourceId, oauthResources.identifier),
                sql`${oauthClientResources.deletedAt} is null`,
              ),
            )
            .where(
              and(
                eq(members.id, input.memberId),
                eq(users.id, input.userId),
                isEffective(members),
                eq(users.status, "active"),
                sql`${users.deletedAt} is null`,
                eq(organizations.status, "active"),
                sql`${organizations.deletedAt} is null`,
                sql`${sessions.expiresAt} > statement_timestamp()`,
                eq(oauthClients.disabled, false),
                sql`${oauthClients.deletedAt} is null`,
                input.resource === null
                  ? undefined
                  : eq(oauthResources.disabled, false),
                input.resource === null
                  ? undefined
                  : sql`${oauthResources.deletedAt} is null and ${oauthClientResources.id} is not null`,
                sql`${oauthClients.grantTypes} @> ARRAY['authorization_code']::text[]`,
                sql`cardinality(${scopeArray}) > 0 and ${scopeArray} <@ ${oauthClients.scopes}`,
                input.resource === null
                  ? undefined
                  : or(
                      eq(oauthResources.classification, "platform_shared"),
                      eq(oauthResources.organizationId, members.organizationId),
                    ),
              ),
            ),
        )
        .returning();
      if (!row) throw new APIError("FORBIDDEN", { error: "access_denied" });
      return row;
    },
  ).catch(rethrowGrantError);
}
