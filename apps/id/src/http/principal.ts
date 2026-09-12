import { recordAdministrativeDenial } from "./denial-audit.ts";
import { boundedUserAgent } from "../lib/user-agent.ts";
import { APIError } from "better-auth/api";
import type { MiddlewareHandler } from "hono";
import { machineIdentitySchema } from "../auth/machine-identity.ts";
import {
  createLocalJWKSet,
  decodeJwt,
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
} from "../db/client-principal.ts";
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
  expiresAt: number;
  clientInstance: string;
  organizationId: string;
  authorizationVersion: number;
  organizationAuthorizationVersion: number;
  clientId: string;
  scopes: string[];
  sid?: unknown;
};
export type PrincipalDeps = {
  hasPlatformWriter(
    db: Database,
    input: { resource: string },
  ): Promise<boolean>;
  getSession(headers: Headers): Promise<{
    session: { id: string };
    user: { id: string; email: string; status: string };
  } | null>;
  verifyBearer(token: string): Promise<BearerClaims>;
  loadGrants(
    db: Database,
    principal: { userId: string; sessionId: string },
    resource: string,
  ): Promise<Grant[]>;
  findClient(
    db: Database,
    clientId: string,
    resource: string,
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
      algorithms: ["EdDSA"],
      requiredClaims: ["exp"],
    });
    const clientId = payload.client_id;
    if (
      typeof clientId !== "string" ||
      !clientId ||
      payload.sub !== clientId ||
      (payload.azp !== undefined && payload.azp !== clientId)
    )
      throw new Error("Missing client identity");
    const identity = machineIdentitySchema.parse(payload);
    return {
      expiresAt: payload.exp!,
      clientInstance: identity.client_instance,
      organizationId: identity.organization_id,
      authorizationVersion: identity.authorization_version,
      organizationAuthorizationVersion:
        identity.organization_authorization_version,
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
  let unknownKeyReloadAt = -Infinity;
  let loading: Promise<ReturnType<typeof createLocalJWKSet>> | undefined;
  function refresh() {
    // Share store work, not verification results or attacker-supplied key IDs.
    loading ??= (async () => {
      const resolver = createLocalJWKSet(await auth.api.getJwks());
      cached = resolver;
      expiresAt = Date.now() + 5 * 60 * 1000;
      return resolver;
    })().finally(() => {
      loading = undefined;
    });
    return loading;
  }
  return async (header, token) => {
    const fresh = !cached || Date.now() >= expiresAt;
    const resolver = fresh ? await refresh() : cached!;
    try {
      return await resolver(header, token);
    } catch (error) {
      // A just-loaded set cannot improve by immediately loading it again.
      if (!(error instanceof errors.JWKSNoMatchingKey) || fresh) throw error;
      // Another verification may have refreshed while this one inspected its set.
      if (cached === resolver && !loading) {
        if (Date.now() - unknownKeyReloadAt < 30_000) throw error;
        unknownKeyReloadAt = Date.now();
      }
      const current = cached !== resolver ? cached! : await refresh();
      return current(header, token);
    }
  };
}

export function createDefaultPrincipalDeps({
  auth,
  environment,
}: Pick<AppServices, "auth" | "environment">): PrincipalDeps {
  return {
    getSession: async (headers) => {
      try {
        return await auth.api.getSession({
          headers,
          query: { disableRefresh: true },
        });
      } catch (error) {
        if (
          error instanceof APIError &&
          error.status === "INTERNAL_SERVER_ERROR"
        )
          throw new ProblemError(
            503,
            "authentication_unavailable",
            "Authentication is unavailable",
            "Retry after the indicated delay.",
            { retryable: true },
          );
        throw error;
      }
    },
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
    let clientId: string | undefined;
    let claimedClientId: string | undefined;
    let principal: Principal;
    try {
      if (authorization && /^Bearer(?:\s|$)/i.test(authorization)) {
        const invalidToken = (detail?: string) => {
          context.header("WWW-Authenticate", 'Bearer error="invalid_token"');
          return new ProblemError(
            401,
            "invalid_token",
            "Invalid token",
            detail,
          );
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
              resource: environment.adminResourceIdentifier,
            }))
          ) {
            await recordAdministrativeDenial(db, {
              actorType: "system",
              actorId: "root",
              action: "admin.root_request",
              reason: "root_locked",
              targetType: "route",
              targetId: context.req.path,
              requestId: context.get("requestId"),
              ip: context.get("clientIp"),
              userAgent:
                boundedUserAgent(context.req.header("user-agent")) ?? undefined,
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
          // An unverified claim is recorded as metadata only; the actor is
          // attributed solely after signature verification.
          try {
            const claimed = decodeJwt(token).client_id;
            if (typeof claimed === "string" && claimed)
              claimedClientId = claimed;
          } catch {
            /* Malformed credentials remain anonymous. */
          }
          let claims: BearerClaims;
          try {
            claims = await deps.verifyBearer(token);
            clientId = claims.clientId;
          } catch {
            throw invalidToken();
          }
          const client = await deps.findClient(
            db,
            claims.clientId,
            environment.adminResourceIdentifier,
          );
          if (
            !client ||
            client.disabled ||
            !Number.isFinite(claims.expiresAt) ||
            claims.expiresAt <= Date.now() / 1000
          )
            throw invalidToken();
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
          if (
            claims.clientInstance !== client.id ||
            claims.organizationId !== client.organizationId ||
            claims.authorizationVersion !== client.authorizationVersion ||
            claims.organizationAuthorizationVersion !==
              client.organization.authorizationVersion
          )
            throw invalidToken();
          if (claims.sid !== undefined)
            throw invalidToken(
              "User-delegated tokens are not admin credentials.",
            );
          context.set("bearerClaims", claims);
          const scopes = [
            ...new Set(
              claims.scopes.filter(
                (scope) =>
                  isAdminScope(scope) &&
                  client.clientCredentialsScopes?.includes(scope) &&
                  (client.resourceScopes === null ||
                    client.resourceScopes.includes(scope)),
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
                isPlatform: client.isPlatform,
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
            { userId: session.user.id, sessionId: session.session.id },
            environment.adminResourceIdentifier,
          ),
        };
      }
    } catch (error) {
      if (
        error instanceof ProblemError &&
        [
          "invalid_token",
          "unauthenticated",
          "user_disabled",
          "untrusted_origin",
          "origin_required",
          "client_unowned",
          "organization_disabled",
        ].includes(error.code)
      ) {
        await recordAdministrativeDenial(db, {
          actorType: clientId ? "client" : "system",
          actorId: clientId ?? "anonymous",
          action: "admin.auth_failed",
          reason: error.code,
          targetType: "route",
          targetId: context.req.path,
          requestId: context.get("requestId"),
          ip: context.get("clientIp"),
          userAgent: boundedUserAgent(context.req.header("user-agent")),
          data: claimedClientId ? { claimedClientId } : undefined,
        });
      }
      throw error;
    }
    context.set("principal", principal);
    await next();
  };
}
