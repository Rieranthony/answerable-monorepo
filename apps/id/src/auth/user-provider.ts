import {
  getOAuthProviderState,
  oauthProvider,
  type OAuthOptions,
} from "@better-auth/oauth-provider";
import {
  addOAuthServerContext,
  createAuthEndpoint,
  createAuthMiddleware,
  sessionMiddleware,
} from "better-auth/api";
import type { HookEndpointContext } from "@better-auth/core";
import { z } from "zod";
import type { Database } from "../db/client.ts";
import { machineOAuthProvider } from "./machine-provider.ts";
import { machineIdentity } from "./machine-identity.ts";
import { createUserOAuthFlow } from "./user-oauth-flow.ts";
import { createUserTokenBoundary } from "./user-token-boundary.ts";
import { revokeUserToken } from "./user-token-revocation.ts";

const redirectResponse = {
  description: "Continue the browser to the server-validated URL.",
  content: {
    "application/json": {
      schema: {
        type: "object" as const,
        required: ["redirect", "url"],
        properties: {
          redirect: { type: "boolean" as const },
          url: { type: "string" as const },
        },
      },
    },
  },
};

const flowResponse = z.object({
  client: z.object({
    clientId: z.string(),
    name: z.string().nullable(),
    uri: z.string().nullable(),
  }),
  resource: z.object({ identifier: z.string(), name: z.string() }).nullable(),
  scopes: z.array(z.string()),
  memberships: z.array(
    z.object({
      memberId: z.uuid(),
      organizationId: z.uuid(),
      name: z.string(),
      slug: z.string(),
      authenticated: z.boolean(),
    }),
  ),
  selectedMemberId: z.uuid().nullable(),
  status: z.enum(["selection", "consent"]),
});

/** Compose application policy around the installed native provider. */
export function userOAuthProvider(
  db: Database,
  options: OAuthOptions<string[]>,
  selectionPage: string,
) {
  const flow = createUserOAuthFlow(options, selectionPage);
  const machine = machineIdentity();
  const user = createUserTokenBoundary();
  const native = oauthProvider({
    ...options,
    postLogin: flow.postLogin,
    extensions: [
      {
        claims: {
          accessToken: (input) =>
            input.grantType === "client_credentials"
              ? machine.claims!.accessToken!(input)
              : user.extension.claims!.accessToken!(input),
          idToken: user.extension.claims!.idToken,
          userInfo: user.extension.claims!.userInfo,
        },
      },
    ],
  });
  const provider = machineOAuthProvider(db, native.options, native);
  const authorize = native.endpoints.oauth2Authorize;
  const continuation = native.endpoints.oauth2Continue;
  const consent = native.endpoints.oauth2Consent;
  return {
    ...provider,
    hooks: {
      ...provider.hooks,
      before: [
        ...provider.hooks.before,
        {
          matcher: (ctx: HookEndpointContext) =>
            ctx.path === "/sign-in/sso" && !!ctx.body?.oauth_query,
          handler: createAuthMiddleware(async () => {
            // The native before hook has verified the browser query. Carry its supported
            // server context through SSO just as the provider does for social sign-in.
            const state = await getOAuthProviderState();
            if (state?.query)
              await addOAuthServerContext({
                query: state.query,
                ...(state.signedQueryIssuedAt
                  ? {
                      signedQueryIssuedAtMs:
                        state.signedQueryIssuedAt.getTime(),
                    }
                  : {}),
              });
          }),
        },
      ],
    },
    endpoints: {
      ...provider.endpoints,
      oauth2UserInfo: createAuthEndpoint(
        native.endpoints.oauth2UserInfo.path,
        native.endpoints.oauth2UserInfo.options,
        (ctx) => user.userInfo(ctx, native.endpoints.oauth2UserInfo),
      ),
      oauth2Revoke: createAuthEndpoint(
        native.endpoints.oauth2Revoke.path,
        native.endpoints.oauth2Revoke.options,
        (ctx) => revokeUserToken(ctx, native),
      ),
      oauth2Token: createAuthEndpoint(
        provider.endpoints.oauth2Token.path,
        provider.endpoints.oauth2Token.options,
        (ctx) =>
          ctx.body.grant_type === "authorization_code" ||
          ctx.body.grant_type === "refresh_token"
            ? user.handle(ctx, native.options, native.endpoints.oauth2Token)
            : provider.endpoints.oauth2Token({
                ...ctx,
                asResponse: false,
                returnHeaders: false,
                returnStatus: false,
              }),
      ),
      oauth2Authorize: createAuthEndpoint(
        authorize.path,
        authorize.options,
        (ctx) =>
          flow.start(ctx, (bound) => authorize({ ...bound, asResponse: true })),
      ),
      oauth2Continue: createAuthEndpoint(
        continuation.path,
        {
          ...continuation.options,
          body: continuation.options.body.extend({ memberId: z.uuid() }),
          metadata: {
            ...continuation.options.metadata,
            openapi: {
              ...continuation.options.metadata.openapi,
              responses: {
                ...continuation.options.metadata.openapi.responses,
                200: redirectResponse,
              },
            },
          },
        },
        (ctx) =>
          flow.resume(ctx, "continue", (bound) =>
            continuation({
              ...bound,
              asResponse: false,
              returnHeaders: false,
              returnStatus: false,
            }),
          ),
      ),
      oauth2Consent: createAuthEndpoint(
        consent.path,
        {
          ...consent.options,
          metadata: {
            ...consent.options.metadata,
            openapi: {
              ...consent.options.metadata.openapi,
              responses: {
                ...consent.options.metadata.openapi.responses,
                200: redirectResponse,
              },
            },
          },
        },
        (ctx) =>
          flow.resume(ctx, "consent", (bound) =>
            consent({
              ...bound,
              asResponse: false,
              returnHeaders: false,
              returnStatus: false,
            }),
          ),
      ),
      oauth2Flow: createAuthEndpoint(
        "/oauth2/flow",
        {
          method: "POST",
          body: z.object({ oauth_query: z.string() }),
          use: [sessionMiddleware],
          metadata: {
            openapi: {
              responses: {
                200: {
                  description:
                    "Registered application details and the current user's eligible organisations.",
                  content: {
                    "application/json": {
                      schema: {
                        ...z.toJSONSchema(flowResponse),
                        type: "object" as const,
                      },
                    },
                  },
                },
              },
            },
          },
        },
        (ctx) => flow.resume(ctx, "details"),
      ),
    },
  };
}
