import { authDatabaseAdapter } from "./auth/database-adapter.ts";
import { machineOAuthProvider } from "./auth/machine-provider.ts";
import { machineIdentity } from "./auth/machine-identity.ts";
import { sso } from "@better-auth/sso";
import { betterAuth } from "better-auth";
import { APIError, isAPIError } from "better-auth/api";
import { openAPI } from "better-auth/plugins";
import { jwt } from "better-auth/plugins/jwt";
import { organization } from "better-auth/plugins/organization";

import { sessionAuditHooks } from "./auth/audit-hooks.ts";
import { signInAudit } from "./auth/signin-audit-plugin.ts";
import type { Database } from "./db/client.ts";
import { answerableSchema } from "./auth/answerable-schema.ts";
import {
  lifecycleStatuses,
  userStatuses,
  membershipStatuses,
} from "./db/schema/vocabulary.ts";
import type { Environment } from "./env.ts";
import { createId } from "./lib/id.ts";
import { createSsoOriginBoundary } from "./auth/sso-origin.ts";
import { upstreamTokenStorage } from "./auth/upstream-token-storage.ts";
import { createVerifiedSso } from "./auth/verified-sso.ts";

export function createAuth(db: Database, environment: Environment) {
  const verifiedSso = createVerifiedSso(db);
  const ssoOrigin = createSsoOriginBoundary(verifiedSso);
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
        },
      },
    },
    redirectURI: "/sso/callback",
    providersLimit: 0,
    organizationProvisioning: { defaultRole: "member" },
    resolveUser: ssoOrigin.resolveUser,
  });
  const auth = betterAuth({
    appName: "Answerable ID",
    onAPIError: {
      onError(error) {
        if (isAPIError(error)) return;

        console.error(
          "[id] auth",
          JSON.stringify({ level: "error", event: "provider_diagnostic" }),
        );
        // Throw a safe protocol error so the native router cannot log the raw exception.
        throw new APIError("INTERNAL_SERVER_ERROR", {
          code: "authentication_unavailable",
          message: "Authentication is temporarily unavailable",
        });
      },
    },
    // Provider diagnostics may contain SQL parameters, tokens or upstream bodies.
    // Preserve a severity signal, never free-form messages or argument objects.
    logger: {
      level: "warn",
      log: (level) =>
        console.error(
          "[id] auth",
          JSON.stringify({ level, event: "provider_diagnostic" }),
        ),
    },
    baseURL: environment.betterAuthUrl,
    basePath: "/auth",
    secret: environment.betterAuthSecret,
    secrets: environment.betterAuthSecrets,
    database: authDatabaseAdapter(
      db,
      ssoOrigin.observeProviders,
      verifiedSso.beforeTransaction,
    ),
    databaseHooks: {
      session: {
        ...sessionAuditHooks(db),
        create: { before: ssoOrigin.before },
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
    trustedOrigins: environment.trustedOrigins,
    account: {
      // The storage plugin protects all three fields; do not encrypt twice.
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
        // Every user Better Auth creates starts inert, including one created
        // by a successful upstream login; activation is an explicit step.
        status: {
          type: [...userStatuses],
          required: true,
          defaultValue: "inert",
          input: false,
        },
        disabledAt: {
          type: "date",
          required: false,
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
      // No verified ingress/peer contract yet. Keep the native shared rate limit;
      // disableIpTracking would bypass it when no address is available.
      ipAddress: { ipAddressHeaders: [] },
      database: {
        generateId: createId,
        joins: true,
      },
    },
    plugins: [
      answerableSchema(),
      upstreamTokenStorage(environment.upstreamTokenSecrets),
      organization({
        allowUserToCreateOrganization: false,
        schema: {
          invitation: {
            additionalFields: {
              deletedAt: {
                type: "date",
                required: false,
                input: false,
                returned: false,
              },
            },
          },
          organization: {
            additionalFields: {
              deletedAt: {
                type: "date",
                required: false,
                input: false,
                returned: false,
              },
              authorizationVersion: {
                type: "number",
                required: true,
                defaultValue: 1,
                input: false,
              },
              status: {
                type: [...lifecycleStatuses],
                required: true,
                defaultValue: "active",
                input: false,
              },
              disabledAt: {
                type: "date",
                required: false,
                input: false,
              },
              updatedAt: {
                type: "date",
                required: false,
                input: false,
              },
            },
          },
          member: {
            additionalFields: {
              deletedAt: {
                type: "date",
                required: false,
                input: false,
                returned: false,
              },
              status: {
                type: [...membershipStatuses],
                required: true,
                defaultValue: "active",
                input: false,
              },
              revokedAt: { type: "date", required: false, input: false },
              validFrom: {
                type: "date",
                required: false,
                input: false,
              },
              validUntil: {
                type: "date",
                required: false,
                input: false,
              },
            },
          },
        },
      }),
      // Token-signing keys for ID tokens and JWT access tokens. The model is
      // named in the singular so the plural table is `jwks`, not `jwkss`.
      // The issuer is the bare origin (id.answerable.org), not the /auth
      // mount; discovery is served at the root in the provider milestone.
      jwt({
        jwt: { issuer: environment.betterAuthUrl },
        schema: { jwks: { modelName: "jwk" } },
      }),
      nativeSso,
      verifiedSso.plugin(nativeSso),
      // OIDC provider for our apps and OAuth 2.1 authorization server for MCP
      // servers. The login and consent pages arrive with the federation and
      // provider milestones; until then no OAuth route is allowlisted.
      machineOAuthProvider(db, {
        extensions: [machineIdentity()],
        // hashClientSecret mirrors this digest for bootstrap clients.
        storeClientSecret: "hashed",
        loginPage: `${environment.authPagesUrl}/login`,
        consentPage: `${environment.authPagesUrl}/consent`,
      }),
      openAPI({ disableDefaultReference: true }),
      // Listed last so its after-hook runs once the SSO plugin has provisioned
      // the membership.
      signInAudit(db),
    ],
  });
  return {
    ...auth,
    handler: (request: Request) =>
      verifiedSso.run(() => ssoOrigin.run(() => auth.handler(request))),
  };
}

export type Auth = ReturnType<typeof createAuth>;
