import { authDatabaseAdapter } from "./auth/database-adapter.ts";
import { userOAuthProvider } from "./auth/user-provider.ts";
import { sso } from "@better-auth/sso";
import { betterAuth } from "better-auth";
import { openAPI } from "better-auth/plugins";
import { jwt } from "better-auth/plugins/jwt";

import { sessionAuditHooks } from "./auth/audit-hooks.ts";
import type { Database } from "./db/client.ts";
import { answerableSchema } from "./auth/answerable-schema.ts";
import type { Environment } from "./env.ts";
import { errorFields } from "./http/problem.ts";
import { createId } from "./lib/id.ts";
import { hashClientSecret } from "./services/client-secrets.ts";
import { logEvent } from "./lib/log.ts";
import { createSsoOriginBoundary } from "./auth/sso-origin.ts";
import { sessionRefreshBoundary } from "./auth/session-refresh.ts";
import { createVerifiedSso } from "./auth/verified-sso.ts";
import { grantLifetimeSeconds } from "./auth/user-oauth-flow.ts";
import { magicLinkPlugin } from "./auth/magic-link.ts";
import { magicLinkConfirmation } from "./auth/magic-link-confirm.ts";

export function createAuth(db: Database, environment: Environment) {
  const verifiedSso = createVerifiedSso(db);
  const ssoOrigin = createSsoOriginBoundary(db, verifiedSso);
  const nativeSso = sso({
    schema: {
      ssoProvider: {
        additionalFields: {
          revision: {
            type: "number",
            required: false,
            input: false,
            returned: false,
          },
          // The adapter's read filter names it (database-adapter.ts).
          kind: {
            type: "string",
            required: false,
            input: false,
            returned: false,
          },
        },
      },
    },
    redirectURI: "/sso/callback",
    providersLimit: 0,
    // ID provisions the membership in the callback transaction (sso-origin.ts).
    organizationProvisioning: { disabled: true },
    resolveUser: ssoOrigin.resolveUser,
  });
  const auth = betterAuth({
    appName: "Answerable ID",
    onAPIError: {
      errorURL: `${environment.betterAuthUrl}/error`,
      // The native router prints the raw exception of an unexpected error it
      // answers itself, and ignores what a hook throws. Rethrown, the exception
      // reaches the handler below without passing through that log.
      throw: true,
    },
    // Provider diagnostics may contain SQL parameters, tokens or upstream bodies.
    // Preserve a severity signal, never free-form messages or argument objects.
    logger: {
      level: "warn",
      log: (level) => logEvent("auth", "provider_diagnostic", { level }),
    },
    baseURL: environment.betterAuthUrl,
    basePath: "/auth",
    secret: environment.betterAuthSecret,
    secrets: environment.betterAuthSecrets,
    database: authDatabaseAdapter(
      db,
      verifiedSso.observe,
      verifiedSso.beforeTransaction,
      environment.platformApplications,
    ),
    databaseHooks: {
      session: {
        ...sessionAuditHooks(db),
        create: { before: ssoOrigin.before },
        update: { before: ssoOrigin.refresh },
      },
    },
    session: {
      additionalFields: {
        authenticationAccountId: {
          type: "string",
          required: false,
          input: false,
          returned: false,
        },
        upstreamAuthTime: {
          type: "date",
          required: false,
          input: false,
          returned: false,
        },
        authenticationOrganizationId: {
          type: "string",
          required: false,
          input: false,
          returned: false,
        },
        authenticationProviderId: {
          type: "string",
          required: false,
          input: false,
          returned: false,
        },
        authenticationProviderRevision: {
          type: "number",
          required: false,
          input: false,
          returned: false,
        },
      },
    },
    // The protocol sweep removes expired rows (operations/protocol-sweep.ts), so no
    // sign-in deletes them inside its transaction, under its locks.
    verification: { disableCleanup: true },
    trustedOrigins: environment.trustedOrigins,
    // Production only, per client address per process: replicas multiply these.
    // An office signs in through one egress address; the provider's options
    // below size authorize and token for a host refreshing for all its users.
    rateLimit: {
      customRules: {
        "/sign-in/sso": { window: 10, max: 60 },
        "/sso/callback": { window: 10, max: 300 },
      },
    },
    account: {
      // No upstream token is stored (answerable-schema.ts), so none is encrypted.
      encryptOAuthTokens: false,
      accountLinking: {
        enabled: false,
      },
      additionalFields: {
        deletedAt: {
          type: "date",
          required: false,
          input: false,
          returned: false,
        },
        // ID keys a federated account on issuer and subject. The provider's
        // own key since 1.7.3 is provider and subject, so this column is ID's.
        issuer: {
          type: "string",
          required: true,
          input: false,
        },
        directoryId: {
          type: "string",
          required: false,
          input: false,
        },
        directoryUserId: {
          type: "string",
          required: false,
          input: false,
        },
      },
    },
    user: {
      additionalFields: {
        deletedAt: {
          type: "date",
          required: false,
          input: false,
          returned: false,
        },
        // No default: federation creates its users active, and an insert
        // without a status fails rather than creating a user in no state.
        status: {
          type: "string",
          required: true,
          input: false,
        },
        retiredEmail: {
          type: "string",
          required: false,
          input: false,
        },
      },
    },
    advanced: {
      ipAddress: {
        // Cloudflare overwrites cf-connecting-ip on every request and only
        // Cloudflare can reach Traefik (authenticated origin pulls), so it
        // wins. X-Forwarded-For remains for a path with no Cloudflare in
        // front, such as the local stack.
        ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for"],
        trustedProxies: environment.trustedProxyCidrs,
      },
      database: {
        generateId: createId,
        joins: true,
      },
    },
    plugins: [
      answerableSchema(),
      // In-process only, from the pages: off the allowlist and server-only. First, since its
      // hook says whether a session is refreshed, and another plugin's hook may read one.
      magicLinkConfirmation(db, ssoOrigin),
      // Before verified SSO and the provider too, whose hooks and endpoints read the session.
      sessionRefreshBoundary(),
      // Token-signing keys for ID tokens and JWT access tokens. The model is
      // named in the singular so the plural table is `jwks`, not `jwkss`.
      // The issuer is the bare origin (id.answerable.org), not the /auth
      // mount; discovery is served at the root in the provider milestone.
      jwt({
        disableSettingJwtHeader: true,
        jwt: { issuer: environment.betterAuthUrl },
        schema: { jwks: { modelName: "jwk" } },
      }),
      nativeSso,
      verifiedSso.plugin(nativeSso),
      // Native OIDC and OAuth protocol with current tenant policy at each grant boundary.
      userOAuthProvider(
        db,
        {
          refreshTokenExpiresIn: grantLifetimeSeconds,
          // A reused rotated refresh token revokes its family. Parallel
          // refreshes by one host are open as Q-REFRESH-PARALLEL (docs/02).
          refreshTokenReuseInterval: 0,
          // Client creation and rotation store hashClientSecret digests;
          // verification uses the same function, so the two cannot drift.
          storeClientSecret: {
            hash: async (secret: string) => hashClientSecret(secret),
          },
          rateLimit: {
            authorize: { window: 60, max: 300 },
            token: { window: 60, max: 600 },
          },
          loginPage: `${environment.betterAuthUrl}/login`,
          consentPage: `${environment.betterAuthUrl}/consent`,
        },
        `${environment.betterAuthUrl}/authorize`,
      ),
      // Issues tokens in-process; its routes stay off the allowlist (http/auth-allowlist.ts).
      magicLinkPlugin(),
      openAPI({ disableDefaultReference: true }),
    ],
  });
  return {
    ...auth,
    async handler(request: Request) {
      try {
        return await auth.handler(request);
      } catch (error) {
        logEvent("auth", "provider_diagnostic", errorFields(error));
        return Response.json(
          {
            code: "authentication_unavailable",
            message: "Authentication is temporarily unavailable",
          },
          { status: 500 },
        );
      }
    },
  };
}

export type Auth = ReturnType<typeof createAuth>;
