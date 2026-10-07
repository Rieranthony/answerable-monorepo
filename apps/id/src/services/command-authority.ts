import { and, eq, sql, isNull } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { effectiveGrants, hasPlatformWriter } from "../db/queries/grants.ts";
import { findClientPrincipal } from "../db/client-principal.ts";
import { sessions, users } from "../db/schema/index.ts";
import type { Environment } from "../env.ts";
import type { Principal, BearerClaims } from "../http/principal.ts";
import { ProblemError } from "../http/problem.ts";
import type { AdminScope } from "../http/admin/scopes.ts";
import { freshAuthenticationGuard } from "../auth/fresh-authentication.ts";

/** Re-evaluate current database authority and return the tier that admitted the caller. */
export async function authorizeCommand(
  tx: Executor,
  principal: Principal,
  environment: Environment,
  required: {
    freshAuthentication?: boolean;
    platform: AdminScope;
    tenant?: { organizationId: string; scope: AdminScope };
  },
  claims?: BearerClaims,
): Promise<"platform" | "tenant"> {
  if (principal.type === "root") {
    if (
      !environment.rootAdminSecret ||
      (!environment.rootAdminBreakGlass &&
        (await hasPlatformWriter(tx, {
          resource: environment.adminResourceIdentifier,
        })))
    )
      throw new ProblemError(403, "root_locked", "Root is locked");
    return "platform";
  }
  if (principal.type === "user") {
    const [session] = await tx
      .select({ id: sessions.id })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(
        and(
          eq(sessions.id, principal.sessionId),
          eq(users.id, principal.userId),
          eq(users.status, "active"),
          isNull(users.deletedAt),
          sql`${sessions.expiresAt} > statement_timestamp()`,
        ),
      )
      .for("share");
    if (!session)
      throw new ProblemError(
        401,
        "unauthenticated",
        "Current session is required",
      );
    const grants = await effectiveGrants(
      tx,
      { userId: principal.userId, sessionId: principal.sessionId },
      environment.adminResourceIdentifier,
    );
    // Row locks prevent deletion, not the passage of time while policy locks wait.
    const [currentSession] = await tx
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.id, principal.sessionId),
          sql`${sessions.expiresAt} > statement_timestamp()`,
        ),
      );
    if (!currentSession)
      throw new ProblemError(
        401,
        "unauthenticated",
        "Current session is required",
      );
    if (required.freshAuthentication)
      await freshAuthenticationGuard(tx, principal.sessionId);
    if (
      grants.some(
        (grant) => grant.isPlatform && grant.scopes.includes(required.platform),
      )
    )
      return "platform";
    if (
      required.tenant &&
      grants.some(
        (grant) =>
          grant.organizationId === required.tenant?.organizationId &&
          grant.scopes.includes(required.tenant.scope),
      )
    )
      return "tenant";
  } else {
    const client = await findClientPrincipal(
      tx,
      principal.clientId,
      environment.adminResourceIdentifier,
    );
    if (
      !claims ||
      claims.expiresAt <= Date.now() / 1000 ||
      !client ||
      client.disabled ||
      client.organization?.status !== "active" ||
      claims.clientId !== client.clientId ||
      claims.clientInstance !== client.id ||
      claims.organizationId !== client.organizationId ||
      claims.authorizationVersion !== client.authorizationVersion ||
      claims.organizationAuthorizationVersion !==
        client.organization.authorizationVersion
    )
      throw new ProblemError(
        401,
        "invalid_token",
        "Current client credentials are required",
      );
    const allowed = (scope: AdminScope) =>
      claims.scopes.includes(scope) &&
      client.clientCredentialsScopes?.includes(scope) &&
      (client.resourceScopes === null || client.resourceScopes.includes(scope));
    if (client.isPlatform && allowed(required.platform)) return "platform";
    if (
      required.tenant &&
      client.organizationId === required.tenant.organizationId &&
      allowed(required.tenant.scope)
    )
      return "tenant";
  }
  throw new ProblemError(
    403,
    "insufficient_scope",
    "Current command authority is required",
  );
}
