import { AsyncLocalStorage } from "node:async_hooks";
import {
  getCurrentAdapter,
  runWithTransaction,
} from "@better-auth/core/context";
import {
  getIssuer,
  getOAuthProviderApi,
  type OAuthOptions,
  type OAuthProviderExtension,
  type oauthProvider,
} from "@better-auth/oauth-provider";
import { APIError } from "better-auth/api";
import { eq, sql } from "drizzle-orm";
import { decodeJwt } from "jose";
import { z } from "zod";
import { setDatabaseScope } from "../db/isolation.ts";
import { grantContexts, oauthResources } from "../db/schema/index.ts";
import { authTransaction } from "./database-adapter.ts";
import { currentGrantAuthentication } from "./grant-authentication.ts";
import { identityScopes } from "./grant-scopes.ts";
import { lockResourceGrantPolicy } from "./lock-resource-grant-policy.ts";
import { bindGrantCode, withNativeCodeReplay } from "./native-code-replay.ts";
import { withNativeClientAuthentication } from "./native-client-authentication.ts";
import { withNativeRefreshFamily } from "./native-refresh-family.ts";
import { withNativeTokenCleanup } from "./native-token-cleanup.ts";
import { rethrowGrantError } from "./grant-error.ts";
import { userResourcePolicy } from "./user-resource-policy.ts";
import { recordUserOAuth } from "./user-oauth-audit.ts";

type Context = Parameters<typeof getOAuthProviderApi>[0];
type Decision = Extract<
  Awaited<ReturnType<typeof userResourcePolicy>>,
  { allowed: true }
>;
const invalid = () => new APIError("BAD_REQUEST", { error: "invalid_grant" });
const codeSchema = z.object({
  type: z.literal("authorization_code"),
  referenceId: z.uuid(),
  userId: z.uuid(),
  sessionId: z.uuid(),
  query: z.object({ client_id: z.string(), scope: z.string() }),
  resource: z.array(z.string()),
});
const refreshSchema = z.object({
  referenceId: z.uuid(),
  userId: z.uuid(),
  clientId: z.string(),
  scopes: z.array(z.string()),
  resources: z.array(z.string()).nullable().optional(),
});

export function createUserTokenBoundary() {
  const issuing = new AsyncLocalStorage<{
    decision: Decision;
    minted: boolean;
  }>();
  function identity(decision: Decision) {
    return {
      subject_type: "user",
      organization_id: decision.grant.organizationId,
      membership_id: decision.grant.memberId,
      grant_id: decision.grant.id,
      client_instance: decision.grant.clientInstanceId,
      resource_instance: decision.grant.resourceInstanceId,
      organization_authorization_version:
        decision.organization.authorizationVersion,
      authorization_version: decision.client!.authorizationVersion,
      upstream_auth_time:
        decision.grant.authentication!.upstreamAuthTime === null
          ? null
          : Math.floor(
              new Date(
                decision.grant.authentication!.upstreamAuthTime,
              ).getTime() / 1000,
            ),
    };
  }
  async function readDecision(
    ctx: Context,
    userId: string,
    clientId: string,
    referenceId: string,
    scopes: string[],
  ) {
    const adapter = await getCurrentAdapter(ctx.context.adapter);
    const tx = authTransaction(adapter);
    await setDatabaseScope(tx, { kind: "policy-user", userId });
    await lockResourceGrantPolicy(adapter, { id: referenceId, clientId });
    const [row] = await tx
      .select({ grant: grantContexts, resource: oauthResources.identifier })
      .from(grantContexts)
      .leftJoin(
        oauthResources,
        eq(oauthResources.id, grantContexts.resourceInstanceId),
      )
      .where(eq(grantContexts.id, referenceId));
    if (
      !row ||
      row.grant.userId !== userId ||
      !(await currentGrantAuthentication(tx, row.grant))
    )
      throw invalid();
    const policy = await userResourcePolicy(tx, {
      id: row.grant.id,
      clientId,
      resource: row.resource,
      grantType: "authorization_code",
      requestedScopes: scopes,
    });
    if (!policy.allowed) throw invalid();
    return policy;
  }
  const claims: NonNullable<
    OAuthProviderExtension["claims"]
  >["accessToken"] = async ({
    ctx,
    user,
    client,
    referenceId,
    scopes,
    grantType,
  }) => {
    const issuance = issuing.getStore();
    const decision =
      issuance?.decision ??
      (!grantType && user && referenceId
        ? await readDecision(ctx, user.id, client.clientId, referenceId, scopes)
        : null);
    if (issuance && grantType) issuance.minted = true;
    const current = z.object({ id: z.uuid() }).safeParse(client);
    if (
      !decision ||
      !current.success ||
      decision.grant.userId !== user?.id ||
      decision.grant.id !== referenceId ||
      decision.client?.id !== current.data.id
    )
      throw invalid();
    return identity(decision);
  };
  const extension: OAuthProviderExtension = {
    claims: {
      accessToken: claims,
      idToken: claims,
      userInfo: async ({ ctx, user, client, jwt, scopes }) => {
        if (!client || typeof jwt.grant_id !== "string") throw invalid();
        return identity(
          await readDecision(
            ctx,
            user.id,
            client.clientId,
            jwt.grant_id,
            scopes,
          ),
        );
      },
    },
  };

  function userInfo(
    ctx: Context,
    native: ReturnType<typeof oauthProvider>["endpoints"]["oauth2UserInfo"],
  ) {
    return runWithTransaction(ctx.context.adapter, async () => {
      const adapter = await getCurrentAdapter(ctx.context.adapter);
      const result = await native({
        ...ctx,
        context: {
          ...ctx.context,
          adapter: { ...ctx.context.adapter, ...adapter },
        },
        asResponse: false,
        returnHeaders: true,
        returnStatus: false,
      });
      result.headers.forEach((value, name) => ctx.setHeader(name, value));
      return result.response;
    }).catch(rethrowGrantError);
  }

  async function handle(
    ctx: Context,
    options: OAuthOptions<string[]>,
    token: ReturnType<typeof oauthProvider>["endpoints"]["oauth2Token"],
  ) {
    const kind = ctx.body.grant_type as "authorization_code" | "refresh_token";
    return withNativeClientAuthentication(
      ctx,
      options,
      kind,
      async (authenticated, nativeCreate) => {
        const outcome = await runWithTransaction(
          ctx.context.adapter,
          async () => {
            const adapter = await getCurrentAdapter(ctx.context.adapter);
            const tx = authTransaction(adapter);
            await tx.execute(sql`set local lock_timeout = '2s'`);
            await setDatabaseScope(tx, {
              kind: "grant-client",
              clientId: authenticated.clientId,
            });
            const create = nativeCreate(adapter);
            let storedTokens = false;
            const bound = {
              ...ctx,
              context: {
                ...ctx.context,
                adapter: {
                  ...ctx.context.adapter,
                  ...adapter,
                  create: (async (input: Parameters<typeof create>[0]) => {
                    if (
                      ["oauthAccessToken", "oauthRefreshToken"].includes(
                        input.model,
                      )
                    )
                      storedTokens = true;
                    return create(input);
                  }) as typeof create,
                },
              },
            };
            const api = getOAuthProviderApi(bound, options);
            const hash = await api.hashToken(
              kind === "authorization_code"
                ? (ctx.body.code ?? "")
                : (ctx.body.refresh_token ?? ""),
              kind,
            );
            let reference: {
              id: string;
              userId: string;
              scopes: string[];
              resources: string[];
              sessionId?: string;
            } | null = null;
            if (kind === "authorization_code") {
              const row = await adapter.findOne<{ value: string }>({
                model: "verification",
                where: [{ field: "identifier", value: hash }],
              });
              if (row) {
                const code = codeSchema.safeParse(JSON.parse(row.value));
                if (
                  !code.success ||
                  code.data.query.client_id !== authenticated.clientId
                )
                  throw invalid();
                reference = {
                  id: code.data.referenceId,
                  userId: code.data.userId,
                  sessionId: code.data.sessionId,
                  scopes: code.data.query.scope.split(" ").filter(Boolean),
                  resources: code.data.resource,
                };
              }
            } else {
              const stored = refreshSchema.safeParse(
                await adapter.findOne({
                  model: "oauthRefreshToken",
                  where: [{ field: "token", value: hash }],
                }),
              );
              if (
                !stored.success ||
                stored.data.clientId !== authenticated.clientId
              )
                throw invalid();
              reference = {
                id: stored.data.referenceId,
                userId: stored.data.userId,
                scopes: stored.data.scopes,
                resources: stored.data.resources ?? [],
              };
            }
            let decision: Decision | null = null;
            if (reference) {
              if (reference.resources.length > 1) throw invalid();
              const resource = reference.resources[0] ?? null;
              const requested =
                ctx.body.resource === undefined
                  ? reference.resources
                  : typeof ctx.body.resource === "string"
                    ? [ctx.body.resource]
                    : ctx.body.resource;
              if (
                requested.length !== reference.resources.length ||
                requested[0] !== reference.resources[0]
              )
                throw new APIError("BAD_REQUEST", { error: "invalid_target" });
              const scopes: string[] =
                kind === "refresh_token" && ctx.body.scope !== undefined
                  ? ctx.body.scope.split(" ").filter(Boolean)
                  : reference.scopes;
              if (scopes.some((scope) => !reference!.scopes.includes(scope)))
                throw new APIError("BAD_REQUEST", { error: "invalid_scope" });
              await lockResourceGrantPolicy(adapter, {
                id: reference.id,
                clientId: authenticated.clientId,
              });
              const [grant] = await tx
                .select()
                .from(grantContexts)
                .where(eq(grantContexts.id, reference.id))
                .for("update");
              if (
                !grant ||
                grant.userId !== reference.userId ||
                (reference.sessionId &&
                  grant.authenticationSessionId !== reference.sessionId) ||
                !(await currentGrantAuthentication(tx, grant))
              )
                throw invalid();
              const policy = await userResourcePolicy(tx, {
                id: grant.id,
                clientId: authenticated.clientId,
                resource,
                grantType: kind,
                requestedScopes: scopes,
              });
              if (!policy.allowed) throw invalid();
              decision = policy;
              if (kind === "authorization_code")
                await bindGrantCode(tx, grant.id, hash);
            }
            const execute = (nativeAdapter: typeof bound.context.adapter) =>
              withNativeTokenCleanup(nativeAdapter, (deleteMany) =>
                token({
                  ...bound,
                  context: {
                    ...bound.context,
                    adapter: { ...nativeAdapter, deleteMany },
                  },
                  asResponse: false,
                  returnHeaders: true,
                  returnStatus: false,
                }),
              );
            const run = () =>
              kind === "refresh_token" && decision
                ? withNativeRefreshFamily(
                    bound.context.adapter,
                    tx,
                    {
                      id: decision.grant.id,
                      clientId: authenticated.clientId,
                      userId: decision.grant.userId,
                    },
                    execute,
                  )
                : withNativeCodeReplay(
                    bound.context.adapter,
                    tx,
                    {
                      clientId: authenticated.clientId,
                      authorizationCodeId: hash,
                    },
                    execute,
                  );
            const issuance = decision ? { decision, minted: false } : null;
            const result = issuance
              ? await issuing.run(issuance, run)
              : await run();
            if ("error" in result) {
              const [revoked] = await tx
                .select()
                .from(grantContexts)
                .where(
                  kind === "authorization_code"
                    ? eq(grantContexts.authorizationCodeId, hash)
                    : eq(grantContexts.id, decision!.grant.id),
                );
              if (revoked?.revokedAt)
                await recordUserOAuth(tx, {
                  grant: revoked,
                  clientId: authenticated.clientId,
                  actor: "client",
                  action: "oauth.user.revoked",
                  requestId: ctx.headers?.get("x-request-id"),
                  data: { reason: `${kind}_replay` },
                });
              return result;
            }
            if (!decision) throw invalid();
            const response = result.value.response;
            // Inspect only freshly returned native material. This is an issuance assertion,
            // not authentication of an arbitrary caller-supplied JWT.
            const returnedScopes = response.scope.split(" ").filter(Boolean);
            if (
              returnedScopes.some(
                (scope) => !decision.requestedScopes?.includes(scope),
              )
            )
              throw invalid();
            const expected = decision.scopes;
            const actual =
              decision.resource === null
                ? returnedScopes
                : returnedScopes.filter((scope) => !identityScopes.has(scope));
            if (
              expected.length !== actual.length ||
              expected.some((scope) => !actual.includes(scope))
            )
              throw invalid();
            if (decision.resource !== null) {
              const access = decodeJwt(response.access_token);
              const expectedAudience = [
                decision.resource.identifier,
                ...(decision.requestedScopes?.includes("openid")
                  ? [`${ctx.context.baseURL}/oauth2/userinfo`]
                  : []),
              ];
              const audience =
                typeof access.aud === "string"
                  ? [access.aud]
                  : (access.aud ?? []);
              if (
                access.sub !== decision.grant.userId ||
                access.iss !== getIssuer(bound, options) ||
                access.client_id !== authenticated.clientId ||
                Object.entries(identity(decision)).some(
                  ([key, value]) => access[key] !== value,
                ) ||
                audience.length !== expectedAudience.length ||
                audience.some((value) => !expectedAudience.includes(value))
              )
                throw invalid();
            } else {
              const accessHash = await api.hashToken(
                response.access_token,
                "access_token",
              );
              const access = await adapter.findOne<{
                referenceId: string;
                userId: string;
                clientId: string;
              }>({
                model: "oauthAccessToken",
                where: [{ field: "token", value: accessHash }],
              });
              if (
                access?.referenceId !== decision.grant.id ||
                access.userId !== decision.grant.userId ||
                access.clientId !== authenticated.clientId
              )
                throw invalid();
            }
            if (response.id_token) {
              const id = decodeJwt(response.id_token);
              if (
                id.sub !== decision.grant.userId ||
                id.iss !== getIssuer(bound, options) ||
                id.aud !== authenticated.clientId ||
                id.auth_time !==
                  Math.floor(decision.grant.authTime.getTime() / 1000) ||
                Object.entries(identity(decision)).some(
                  ([key, value]) => id[key] !== value,
                )
              )
                throw invalid();
            }
            await recordUserOAuth(tx, {
              grant: decision.grant,
              clientId: authenticated.clientId,
              actor: "client",
              action:
                issuance?.minted || storedTokens
                  ? "oauth.user.issued"
                  : "oauth.user.replayed",
              requestId: ctx.headers?.get("x-request-id"),
              data: { grantType: kind, scopes: returnedScopes, decision },
            });
            result.value.headers.forEach((value, name) =>
              ctx.setHeader(name, value),
            );
            return { value: response };
          },
        ).catch(rethrowGrantError);
        if ("error" in outcome) throw outcome.error;
        return outcome.value;
      },
    );
  }
  return { extension, handle, userInfo };
}
