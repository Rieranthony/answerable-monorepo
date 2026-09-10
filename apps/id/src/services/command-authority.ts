import { and, eq, sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { effectiveGrants, hasPlatformWriter } from "../db/queries/grants.ts";
import { findClientPrincipal } from "../db/client-principal.ts";
import { sessions, users } from "../db/schema/index.ts";
import type { Environment } from "../env.ts";
import type { Principal, BearerClaims } from "../http/principal.ts";
import { ProblemError } from "../http/problem.ts";
import type { AdminScope } from "../http/admin/scopes.ts";

/** Re-evaluate current database authority and return the tier that admitted the caller. */
export async function authorizeCommand(
  tx: Executor,
  principal: Principal,
  environment: Environment,
  required: {
    platform: AdminScope | readonly AdminScope[];
    tenant?: {
      organizationId: string;
      scope: AdminScope | readonly AdminScope[];
    };
  },
  claims?: BearerClaims,
): Promise<"platform" | "tenant"> {
  const platformScopes =
    typeof required.platform === "string"
      ? [required.platform]
      : required.platform;
  const tenantScopes =
    required.tenant === undefined
      ? []
      : typeof required.tenant.scope === "string"
        ? [required.tenant.scope]
        : required.tenant.scope;
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
          sql`${users.deletedAt} is null`,
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
    if (
      grants.some(
        (grant) =>
          grant.isPlatform &&
          platformScopes.some((scope) => grant.scopes.includes(scope)),
      )
    )
      return "platform";
    if (
      required.tenant &&
      grants.some(
        (grant) =>
          grant.organizationId === required.tenant?.organizationId &&
          tenantScopes.some((scope) => grant.scopes.includes(scope)),
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
      !Number.isFinite(claims.expiresAt) ||
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
    if (client.isPlatform && platformScopes.some(allowed)) return "platform";
    if (
      required.tenant &&
      client.organizationId === required.tenant.organizationId &&
      tenantScopes.some(allowed)
    )
      return "tenant";
  }
  throw new ProblemError(
    403,
    "insufficient_scope",
    "Current command authority is required",
  );
}
