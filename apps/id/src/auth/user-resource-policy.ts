import { and, eq, isNull, sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { withDatabaseScope } from "../db/isolation.ts";
import {
  grantContexts,
  members,
  organizations,
  users,
  oauthClients,
  oauthResources,
} from "../db/schema/index.ts";
import {
  evaluateUserResourcePermission,
  evaluateClientLoginPermission,
  memberPermissionFields,
} from "./member-permission.ts";
/** Caller supplies the authenticated client and native stored reference, never a requested tenant. */
export async function userResourcePolicy(
  executor: Executor,
  input: {
    id: string;
    clientId: string;
    resource: string | null;
    grantType: "authorization_code" | "refresh_token";
    requestedScopes: string[];
  },
) {
  const [subject] = await executor
    .select({ userId: grantContexts.userId })
    .from(grantContexts)
    .where(eq(grantContexts.id, input.id));
  if (!subject) return { allowed: false as const, reason: "context" as const };
  return withDatabaseScope(
    executor,
    { kind: "policy-user", userId: subject.userId },
    async (tx) => {
      // One statement gives all windows and sources the same evaluation instant/snapshot.
      const [row] = await tx
        .select({
          grant: grantContexts,
          ...memberPermissionFields(tx),
        })
        .from(grantContexts)
        .innerJoin(
          members,
          and(
            eq(members.id, grantContexts.memberId),
            eq(members.organizationId, grantContexts.organizationId),
            eq(members.userId, grantContexts.userId),
          ),
        )
        .innerJoin(users, eq(users.id, grantContexts.userId))
        .innerJoin(
          organizations,
          eq(organizations.id, grantContexts.organizationId),
        )
        .innerJoin(
          oauthClients,
          eq(oauthClients.id, grantContexts.clientInstanceId),
        )
        .leftJoin(
          oauthResources,
          eq(oauthResources.id, grantContexts.resourceInstanceId),
        )
        .where(
          and(
            eq(grantContexts.id, input.id),
            eq(oauthClients.clientId, input.clientId),
            input.resource === null
              ? isNull(grantContexts.resourceInstanceId)
              : eq(oauthResources.identifier, input.resource),
            isNull(grantContexts.revokedAt),
            sql`${grantContexts.expiresAt} > statement_timestamp()`,
          ),
        );
      if (!row) return { allowed: false as const, reason: "context" as const };
      const decision =
        input.resource === null
          ? evaluateClientLoginPermission(row, {
              ...input,
              originalScopes: row.grant.requestedScopes,
            })
          : evaluateUserResourcePermission(row, {
              ...input,
              resource: input.resource,
              originalScopes: row.grant.requestedScopes,
            });
      return decision.allowed ? { ...decision, grant: row.grant } : decision;
    },
  );
}
