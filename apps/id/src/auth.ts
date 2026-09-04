import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { oauthProvider } from "@better-auth/oauth-provider";
import { sso } from "@better-auth/sso";
import { betterAuth } from "better-auth";
import { openAPI } from "better-auth/plugins";
import { jwt } from "better-auth/plugins/jwt";
import { organization } from "better-auth/plugins/organization";

import type { Database } from "./db/client.ts";
import { answerableSchema } from "./auth/answerable-schema.ts";
import * as schema from "./db/schema/index.ts";
import { lifecycleStatuses, userStatuses } from "./db/schema/vocabulary.ts";
import type { Environment } from "./env.ts";
import { createId } from "./lib/id.ts";
import { resolveFederatedUser } from "./services/federation.ts";

export function createAuth(db: Database, environment: Environment) {
  return betterAuth({
    appName: "Answerable ID",
    baseURL: environment.betterAuthUrl,
    basePath: "/auth",
    secret: environment.betterAuthSecret,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema,
      usePlural: true,
      transaction: true,
    }),
    trustedOrigins: environment.trustedOrigins,
    account: {
      accountLinking: {
        enabled: false,
      },
      additionalFields: {
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
      database: {
        generateId: createId,
        joins: true,
      },
    },
    plugins: [
      answerableSchema(),
      organization({
        allowUserToCreateOrganization: false,
        schema: {
          organization: {
            additionalFields: {
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
      jwt({ schema: { jwks: { modelName: "jwk" } } }),
      sso({
        redirectURI: "/sso/callback",
        providersLimit: 0,
        organizationProvisioning: { defaultRole: "member" },
        resolveUser: (input, { database }) =>
          resolveFederatedUser(input, database),
      }),
      // OIDC provider for our apps and OAuth 2.1 authorization server for MCP
      // servers. The login and consent pages arrive with the federation and
      // provider milestones; until then no OAuth route is allowlisted.
      oauthProvider({
        loginPage: `${environment.authPagesUrl}/login`,
        consentPage: `${environment.authPagesUrl}/consent`,
      }),
      openAPI({ disableDefaultReference: true }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
