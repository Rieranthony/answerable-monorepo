import {
  getCurrentAdapter,
  runWithTransaction,
} from "@better-auth/core/context";
import {
  getOAuthProviderApi,
  type oauthProvider,
} from "@better-auth/oauth-provider";
import { isAPIError } from "better-auth/api";
import { and, eq, isNull, sql } from "drizzle-orm";
import { grantContexts } from "../db/schema/index.ts";
import { setDatabaseScope } from "../db/isolation.ts";
import { authTransaction } from "./database-adapter.ts";
import { lockResourceGrantPolicy } from "./lock-resource-grant-policy.ts";
import { withNativeClientAuthentication } from "./native-client-authentication.ts";
import { withNativeRefreshFamily } from "./native-refresh-family.ts";
import { withNativeTokenCleanup } from "./native-token-cleanup.ts";
import { recordUserOAuth } from "./user-oauth-audit.ts";
import { rethrowGrantError } from "./grant-error.ts";

type Context = Parameters<typeof getOAuthProviderApi>[0];
type Provider = ReturnType<typeof oauthProvider>;

export function revokeUserToken(ctx: Context, provider: Provider) {
  ctx.setHeader("Cache-Control", "no-store");
  return withNativeClientAuthentication(
    ctx,
    provider.options,
    undefined,
    async (client, nativeCreate) => {
      const outcome = await runWithTransaction(
        ctx.context.adapter,
        async () => {
          const adapter = await getCurrentAdapter(ctx.context.adapter);
          const tx = authTransaction(adapter);
          await setDatabaseScope(tx, {
            kind: "grant-client",
            clientId: client.clientId,
          });
          const boundAdapter = {
            ...ctx.context.adapter,
            ...adapter,
            create: nativeCreate(adapter),
            findOne: (async (input: Parameters<typeof adapter.findOne>[0]) =>
              adapter.findOne(
                ["oauthAccessToken", "oauthRefreshToken"].includes(input.model)
                  ? {
                      ...input,
                      where: [
                        ...(input.where ?? []),
                        { field: "clientId", value: client.clientId },
                      ],
                    }
                  : input,
              )) as typeof adapter.findOne,
          };
          const bound = {
            ...ctx,
            context: { ...ctx.context, adapter: boundAdapter },
          };
          const api = getOAuthProviderApi(bound, provider.options);
          const token: string = ctx.body.token;
          const refresh =
            ctx.body.token_type_hint === "access_token"
              ? null
              : await boundAdapter.findOne<{ referenceId: string }>({
                  model: "oauthRefreshToken",
                  where: [
                    {
                      field: "token",
                      value: await api.hashToken(token, "refresh_token"),
                    },
                  ],
                });
          const access =
            refresh || ctx.body.token_type_hint === "refresh_token"
              ? null
              : await boundAdapter.findOne<{ referenceId: string }>({
                  model: "oauthAccessToken",
                  where: [
                    {
                      field: "token",
                      value: await api.hashToken(token, "access_token"),
                    },
                  ],
                });
          const referenceId = refresh?.referenceId ?? access?.referenceId;
          let grant: typeof grantContexts.$inferSelect | null = null;
          if (referenceId) {
            await lockResourceGrantPolicy(adapter, {
              id: referenceId,
              clientId: client.clientId,
            });
            [grant = null] = await tx
              .select()
              .from(grantContexts)
              .where(eq(grantContexts.id, referenceId))
              .for("update");
          }
          const execute = (scoped: typeof boundAdapter) =>
            withNativeTokenCleanup(scoped, (deleteMany) =>
              provider.endpoints.oauth2Revoke({
                ...bound,
                context: {
                  ...bound.context,
                  adapter: { ...scoped, deleteMany },
                },
                asResponse: false,
                returnHeaders: true,
                returnStatus: false,
              }),
            ).catch((error: unknown) => {
              if (
                !referenceId &&
                token.length > 0 &&
                isAPIError(error) &&
                error.body?.error === "invalid_request"
              )
                return { response: null, headers: new Headers() };
              throw error;
            });
          const result =
            grant && refresh
              ? await withNativeRefreshFamily(
                  boundAdapter,
                  tx,
                  {
                    id: grant.id,
                    userId: grant.userId,
                    clientId: client.clientId,
                  },
                  execute,
                  true,
                )
              : { value: await execute(boundAdapter) };
          if (grant) {
            if (refresh)
              await tx
                .update(grantContexts)
                .set({ revokedAt: sql`statement_timestamp()` })
                .where(
                  and(
                    eq(grantContexts.id, grant.id),
                    isNull(grantContexts.revokedAt),
                  ),
                );
            await recordUserOAuth(tx, {
              action: "oauth.user.revoked",
              actor: "client",
              clientId: client.clientId,
              grant,
              requestId: ctx.headers?.get("x-request-id"),
              data: { effect: refresh ? "refresh_family" : "access_token" },
            });
          }
          // The pinned provider reports its completed revoked-family cleanup as
          // invalid_request. RFC 7009 requires the same empty success for repeat revocation.
          if ("error" in result)
            return isAPIError(result.error) &&
              result.error.body?.error === "invalid_request"
              ? { value: null }
              : result;
          return { value: result.value.response };
        },
      ).catch(rethrowGrantError);
      if ("error" in outcome) throw outcome.error;
      return outcome.value;
    },
  );
}
