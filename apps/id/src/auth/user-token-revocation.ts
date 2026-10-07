import {
  getOAuthProviderApi,
  type oauthProvider,
} from "@better-auth/oauth-provider";
import { isAPIError } from "better-auth/api";
import { eq } from "drizzle-orm";
import { revokeGrantContexts } from "../db/queries/grant-contexts.ts";
import { grantContexts } from "../db/schema/index.ts";
import { setDatabaseScope } from "../db/isolation.ts";
import { grantTransaction, withAdapter } from "./database-adapter.ts";
import { lockResourceGrantPolicy } from "./lock-resource-grant-policy.ts";
import {
  withNativeClientAuthentication,
  type NativeContext,
} from "./native-client-authentication.ts";
import { withNativeRefreshFamily } from "./native-refresh-family.ts";
import { withNativeTokenCleanup } from "./native-token-cleanup.ts";
import { recordUserOAuth } from "./user-oauth-audit.ts";

type Provider = ReturnType<typeof oauthProvider>;

export function revokeUserToken(ctx: NativeContext, provider: Provider) {
  ctx.setHeader("Cache-Control", "no-store");
  return withNativeClientAuthentication(
    ctx,
    provider.options,
    undefined,
    async (client, nativeCreate) => {
      const outcome = await grantTransaction(
        ctx.context.adapter,
        async (adapter, tx) => {
          await setDatabaseScope(tx, {
            kind: "grant-client",
            clientId: client.clientId,
          });
          const bound = withAdapter(ctx, {
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
          });
          const boundAdapter = bound.context.adapter;
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
              await revokeGrantContexts(tx, eq(grantContexts.id, grant.id));
            await recordUserOAuth(tx, {
              action: "oauth.user.revoked",
              actor: "client",
              clientId: client.clientId,
              grant,
              requestId: ctx.headers?.get("x-request-id"),
              data: {
                reason: "revocation_request",
                effect: refresh ? "refresh_family" : "access_token",
              },
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
      );
      if ("error" in outcome) throw outcome.error;
      return outcome.value;
    },
  );
}
