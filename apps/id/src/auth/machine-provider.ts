import { rethrowGrantError } from "./grant-error.ts";
import { admitMachineIssuance } from "./machine-admission.ts";
import { identityScopes } from "./grant-scopes.ts";
import { machineCapability } from "./machine-capability.ts";
import {
  getCurrentAdapter,
  runWithTransaction,
} from "@better-auth/core/context";
import {
  getOAuthProviderApi,
  oauthProvider,
  type OAuthOptions,
} from "@better-auth/oauth-provider";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { authTransaction } from "./database-adapter.ts";
import {
  recordMachineIssuance,
  recordMachineRejection,
} from "./machine-audit.ts";
import { prepareMachineGrant } from "./machine-identity.ts";

/** Authenticate once; keep issuance and policy evidence in one transaction. */
export function machineOAuthProvider(
  db: Database,
  options: OAuthOptions<string[]>,
) {
  const provider = oauthProvider(options);
  const token = provider.endpoints.oauth2Token;
  return {
    ...provider,
    endpoints: {
      ...provider.endpoints,
      oauth2Token: createAuthEndpoint(
        token.path,
        {
          ...token.options,
          metadata: {
            ...token.options.metadata,
            openapi: {
              ...token.options.metadata.openapi,
              responses: {
                ...token.options.metadata.openapi.responses,
                503: {
                  ...token.options.metadata.openapi.responses[400],
                  description:
                    "Tenant issuance capacity or authorization state is busy, a database statement was cancelled, or issuance audit storage is unavailable. Retry after the indicated delay with fresh client authentication.",
                  headers: {
                    "Retry-After": {
                      description: "Minimum delay in seconds before retrying.",
                      schema: { type: "string" as const, example: "1" },
                    },
                  },
                },
              },
            },
          },
        },
        async (ctx) => {
          if (ctx.body.grant_type !== "client_credentials") {
            throw new APIError("BAD_REQUEST", {
              error: "unsupported_grant_type",
            });
          }
          let authenticatedClient: unknown = null;
          let stage:
            "authentication" | "request" | "authorization" | "issuance" =
            "authentication";
          let evaluatedDecision: Awaited<
            ReturnType<typeof machineCapability>
          > | null = null;
          try {
            // Authentication replay markers must survive a rejected grant.
            const authenticated = await getOAuthProviderApi(
              ctx,
              provider.options,
              "client_credentials",
            ).authenticateClient();
            authenticatedClient = authenticated.client;
            stage = "request";
            const resource = ctx.body.resource;
            if (
              typeof resource !== "string" ||
              (ctx.request &&
                (await ctx.request.clone().formData()).getAll("resource")
                  .length !== 1)
            ) {
              throw new APIError("BAD_REQUEST", {
                error: "invalid_target",
                error_description: "Exactly one resource is required.",
              });
            }
            return await runWithTransaction(ctx.context.adapter, async () => {
              stage = "authorization";
              const adapter = await getCurrentAdapter(ctx.context.adapter);
              await authTransaction(adapter).execute(
                sql`set local lock_timeout = '2s'`,
              );
              const client = await prepareMachineGrant(
                adapter,
                authenticated.client,
                resource,
              );
              await admitMachineIssuance(
                authTransaction(adapter),
                client.organizationId,
              );
              if (!client.grantTypes?.includes("client_credentials"))
                throw new APIError("BAD_REQUEST", {
                  error: "unauthorized_client",
                });
              const requestedScopes =
                ctx.body.scope === undefined
                  ? undefined
                  : ctx.body.scope.split(" ").filter(Boolean);
              if (requestedScopes?.some((scope) => identityScopes.has(scope)))
                throw new APIError("BAD_REQUEST", { error: "invalid_scope" });
              const decision = await machineCapability(
                authTransaction(adapter),
                {
                  organizationId: client.organizationId,
                  clientId: client.clientId,
                  resource,
                  requestedScopes,
                },
              );
              evaluatedDecision = decision;
              if (!decision.allowed)
                throw new APIError("BAD_REQUEST", { error: decision.reason });
              stage = "issuance";
              const issued = await getOAuthProviderApi(
                {
                  ...ctx,
                  context: {
                    ...ctx.context,
                    adapter: { ...ctx.context.adapter, ...adapter },
                  },
                },
                provider.options,
                "client_credentials",
              ).issueTokens({
                client,
                scopes: [...decision.scopes],
                resources: [resource],
              });
              await recordMachineIssuance(authTransaction(adapter), {
                token: issued.access_token,
                decision,
                requestId: ctx.headers?.get("x-request-id"),
              });
              return issued;
            }).catch(rethrowGrantError);
          } catch (error) {
            // The issuance transaction has exited. Record the request failure independently.
            try {
              await db.transaction(async (tx) => {
                await tx.execute(sql`set local lock_timeout = '2s'`);
                await recordMachineRejection(tx, {
                  client: authenticatedClient,
                  stage,
                  error,
                  decision: evaluatedDecision,
                  requestId: ctx.headers?.get("x-request-id"),
                });
              });
            } catch {
              // Do not inspect error objects: driver parameters can contain credentials.
              console.error(
                "[id] auth",
                JSON.stringify({
                  level: "error",
                  event: "token_rejection_audit_unavailable",
                }),
              );
            }
            throw error;
          }
        },
      ),
    },
  };
}
