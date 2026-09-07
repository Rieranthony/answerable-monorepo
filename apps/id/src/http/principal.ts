import type { MiddlewareHandler } from "hono";
import {
  createLocalJWKSet,
  errors,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";
import type { AppServices } from "../app.ts";
import type { Auth } from "../auth.ts";
import type { Database } from "../db/client.ts";
import {
  effectiveGrants,
  hasPlatformWriter,
  type Grant,
} from "../db/queries/grants.ts";
import {
  findClientPrincipal,
  type ClientPrincipalRow,
} from "../db/queries/oauth-clients.ts";
import { recordAuditEvent } from "../db/queries/audit.ts";
import { secretMatches } from "../services/root-secret.ts";
import { isAdminScope } from "./admin/scopes.ts";
import type { AppEnvironment } from "./context.ts";
import { ProblemError } from "./problem.ts";

export type Principal =
  | { type: "root"; grants: [] }
  | {
      type: "user";
      userId: string;
      email: string;
      sessionId: string;
      grants: Grant[];
    }
  | {
      type: "client";
      clientId: string;
      organizationId: string;
      grants: Grant[];
    };
export type Tier = "platform" | "tenant";
export type BearerClaims = {
  clientId: string;
  scopes: string[];
  sid?: unknown;
};
export type PrincipalDeps = {
  hasPlatformWriter(
    db: Database,
    input: { organizationSlug: string; resource: string },
  ): Promise<boolean>;
  getSession(headers: Headers): Promise<{
    session: { id: string };
    user: { id: string; email: string; status: string };
  } | null>;
  verifyBearer(token: string): Promise<BearerClaims>;
  loadGrants(
    db: Database,
    principal: { userId: string },
    resource: string,
  ): Promise<Grant[]>;
  findClient(
    db: Database,
    clientId: string,
  ): Promise<ClientPrincipalRow | null>;
};

export function createBearerVerifier({
  getKey,
  issuer,
  audience,
}: {
  getKey: JWTVerifyGetKey;
  issuer: string;
  audience: string;
}) {
  return async (token: string): Promise<BearerClaims> => {
    const { payload } = await jwtVerify(token, getKey, {
      issuer,
      audience,
      typ: "at+jwt",
    });
    const clientId = payload.azp ?? payload.client_id ?? payload.sub;
    if (typeof clientId !== "string" || !clientId)
      throw new Error("Missing client identity");
    return {
      clientId,
      scopes: String(payload.scope ?? "")
        .split(" ")
        .filter(Boolean),
      sid: payload.sid,
    };
  };
}

export function createJwksResolver(auth: Pick<Auth, "api">): JWTVerifyGetKey {
  let cached: ReturnType<typeof createLocalJWKSet> | undefined;
  let expiresAt = 0;
  async function refresh() {
    cached = createLocalJWKSet(await auth.api.getJwks());
    expiresAt = Date.now() + 5 * 60 * 1000;
    return cached;
  }
  return async (header, token) => {
    const resolver =
      !cached || Date.now() >= expiresAt ? await refresh() : cached;
    try {
      return await resolver(header, token);
    } catch (error) {
      if (!(error instanceof errors.JWKSNoMatchingKey)) throw error;
      return (await refresh())(header, token);
    }
  };
}

export function createDefaultPrincipalDeps({
  auth,
  environment,
}: Pick<AppServices, "auth" | "environment">): PrincipalDeps {
  return {
    getSession: (headers) =>
      auth.api.getSession({ headers, query: { disableRefresh: true } }),
    verifyBearer: createBearerVerifier({
      getKey: createJwksResolver(auth),
      issuer: environment.betterAuthUrl,
      audience: environment.adminResourceIdentifier,
    }),
    hasPlatformWriter,
    loadGrants: effectiveGrants,
    findClient: findClientPrincipal,
  };
}

export function createPrincipalMiddleware(
  deps: PrincipalDeps,
): MiddlewareHandler<AppEnvironment> {
  return async (context, next) => {
    const environment = context.get("environment");
    const db = context.get("db");
    const authorization = context.req.header("Authorization");
    let principal: Principal;
    if (authorization && /^Bearer(?:\s|$)/i.test(authorization)) {
      const invalidToken = (detail?: string) => {
        context.header("WWW-Authenticate", 'Bearer error="invalid_token"');
        return new ProblemError(401, "invalid_token", "Invalid token", detail);
      };
      const token = /^Bearer +([^\s]+)$/i.exec(authorization)?.[1];
      if (!token) throw invalidToken();
      if (
        environment.rootAdminSecret &&
        secretMatches(environment.rootAdminSecret, token)
      ) {
        if (
          !environment.rootAdminBreakGlass &&
          (await deps.hasPlatformWriter(db, {
            organizationSlug: environment.platformOrganizationSlug,
            resource: environment.adminResourceIdentifier,
          }))
        ) {
          await recordAuditEvent(db, {
            actorType: "system",
            actorId: "root",
            action: "admin.root_request",
            outcome: "denied",
            reason: "root_locked",
            targetType: "route",
            targetId: context.req.path,
            requestId: context.get("requestId"),
            ip: context.req.header("x-forwarded-for")?.split(",")[0]?.trim(),
            userAgent: context.req.header("user-agent"),
          });
          throw new ProblemError(
            403,
            "root_locked",
            "Root is locked",
            "A platform administrator exists. Set ROOT_ADMIN_BREAK_GLASS=true to use the root secret.",
          );
        }
        principal = { type: "root", grants: [] };
      } else {
        let claims: BearerClaims;
        try {
          claims = await deps.verifyBearer(token);
        } catch {
          throw invalidToken();
        }
        const client = await deps.findClient(db, claims.clientId);
        if (!client || client.disabled) throw invalidToken();
        if (!client.organizationId)
          throw new ProblemError(
            403,
            "client_unowned",
            "Client has no organisation",
          );
        if (client.organization?.status !== "active")
          throw new ProblemError(
            403,
            "organization_disabled",
            "Organisation is disabled",
          );
        if (claims.sid !== undefined)
          throw invalidToken(
            "User-delegated tokens are not admin credentials.",
          );
        const scopes = [
          ...new Set(
            claims.scopes.filter(
              (scope) =>
                isAdminScope(scope) &&
                client.clientCredentialsScopes?.includes(scope),
            ),
          ),
        ].sort();
        principal = {
          type: "client",
          clientId: client.clientId,
          organizationId: client.organizationId,
          grants: [
            {
              organizationId: client.organizationId,
              organizationSlug: client.organization.slug,
              scopes,
            },
          ],
        };
      }
    } else {
      const session = await deps.getSession(context.req.raw.headers);
      if (!session) {
        context.header(
          "WWW-Authenticate",
          'Bearer realm="answerable-id-admin"',
        );
        throw new ProblemError(
          401,
          "unauthenticated",
          "Authentication is required",
        );
      }
      if (session.user.status !== "active")
        throw new ProblemError(403, "user_disabled", "User is disabled");
      const origin = context.req.header("Origin");
      if (
        origin !== undefined &&
        !environment.trustedOrigins.includes(origin) &&
        origin !== new URL(environment.betterAuthUrl).origin
      ) {
        throw new ProblemError(
          403,
          "untrusted_origin",
          "Origin is not trusted",
        );
      }
      if (
        !["GET", "HEAD", "OPTIONS"].includes(context.req.method) &&
        origin === undefined
      ) {
        throw new ProblemError(403, "origin_required", "Origin is required");
      }
      principal = {
        type: "user",
        userId: session.user.id,
        email: session.user.email,
        sessionId: session.session.id,
        grants: await deps.loadGrants(
          db,
          { userId: session.user.id },
          environment.adminResourceIdentifier,
        ),
      };
    }
    context.set("principal", principal);
    await next();
  };
}
