import { AsyncLocalStorage } from "node:async_hooks";
import {
  getCurrentAdapter,
  runWithTransaction,
} from "@better-auth/core/context";
import {
  getOAuthProviderState,
  type getOAuthProviderApi,
  type OAuthOptions,
} from "@better-auth/oauth-provider";
import { APIError, getSessionFromCtx } from "better-auth/api";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { isEffective } from "../db/queries/effective.ts";
import {
  accounts,
  grantContexts,
  members,
  oauthClients,
  oauthResources,
  organizations,
  sessions,
  ssoProviders,
  verifications,
} from "../db/schema/index.ts";
import { setDatabaseScope } from "../db/isolation.ts";
import { createId } from "../lib/id.ts";
import { authTransaction } from "./database-adapter.ts";
import { createResourceGrant } from "./create-resource-grant.ts";
import { currentGrantAuthentication } from "./grant-authentication.ts";
import { lockResourceGrantPolicy } from "./lock-resource-grant-policy.ts";
import { userResourcePolicy } from "./user-resource-policy.ts";
import { rethrowGrantError } from "./grant-error.ts";
import { recordUserOAuth } from "./user-oauth-audit.ts";

type Context = Parameters<typeof getOAuthProviderApi>[0];
const parameter = "answerable_flow";
const prefix = "answerable-oauth-flow:";
const flowSchema = z.object({
  query: z.string(),
  userId: z.uuid().nullable(),
  grantId: z.uuid().nullable(),
  status: z.enum(["selection", "consent", "complete", "denied"]),
});
type Flow = z.infer<typeof flowSchema>;
const invalid = () =>
  new APIError("BAD_REQUEST", {
    error: "invalid_request",
    error_description:
      "This authorisation flow is unavailable. Start again from the application.",
  });

/** Compare every native-signed field except native continuation flags and prompt state. */
function binding(query: URLSearchParams) {
  const params = new URLSearchParams(query);
  for (const name of [
    "sig",
    "exp",
    "ba_iat",
    "ba_pl",
    "ba_param",
    "prompt",
    "max_age",
  ])
    params.delete(name);
  params.sort();
  return params.toString();
}

export function createUserOAuthFlow(
  options: OAuthOptions<string[]>,
  page: string,
) {
  const active = new AsyncLocalStorage<{ flow: Flow; sessionId: string }>();
  const postLogin: NonNullable<OAuthOptions<string[]>["postLogin"]> = {
    page,
    shouldRedirect: async () => !active.getStore()?.flow.grantId,
    consentReferenceId: async ({ user, session, scopes }) => {
      const current = active.getStore();
      if (
        !current?.flow.grantId ||
        current.flow.userId !== user?.id ||
        current.sessionId !== session?.id ||
        scopes.some(
          (scope) =>
            !new URLSearchParams(current.flow.query)
              .get("scope")
              ?.split(" ")
              .includes(scope),
        )
      )
        throw invalid();
      return current.flow.grantId;
    },
  };

  async function start(ctx: Context, run: (ctx: Context) => Promise<Response>) {
    ctx.setHeader("Cache-Control", "no-store");
    const query = ctx.request?.method === "POST" ? ctx.body : ctx.query;
    if (query?.[parameter]) throw invalid();
    const flowId = createId();
    const next = { ...query, [parameter]: flowId };
    // Native validates the client, redirect, resource, scopes and PKCE before signing.
    const response = await run({
      ...ctx,
      query: next,
      ...(ctx.request?.method === "POST" ? { body: next } : {}),
    });
    const location = response.headers.get("location");
    const result = location
      ? new URL(location)
      : response.status === 200
        ? new URL((await response.clone().json()).url)
        : null;
    if (
      result &&
      [options.loginPage, page].includes(result.origin + result.pathname) &&
      result.searchParams.has("sig")
    ) {
      const session = await getSessionFromCtx(ctx);
      await ctx.context.adapter.create({
        model: "verification",
        data: {
          id: flowId,
          identifier: prefix + flowId,
          value: JSON.stringify({
            query: binding(result.searchParams),
            userId: session?.user.id ?? null,
            grantId: null,
            status: "selection",
          } satisfies Flow),
          expiresAt: new Date(Number(result.searchParams.get("exp")) * 1000),
        },
        forceAllowId: true,
      });
    }
    return response;
  }

  async function resume<T>(
    ctx: Context,
    ...operation:
      | [action: "details"]
      | [action: "continue" | "consent", run: (ctx: Context) => Promise<T>]
  ) {
    const [action, run] = operation;
    ctx.setHeader("Cache-Control", "no-store");
    // The installed provider's before hook verifies the native signature.
    const query = (await getOAuthProviderState())?.query;
    const params = new URLSearchParams(query);
    const flowId = z.uuid().safeParse(params.get(parameter));
    if (!query || !flowId.success) throw invalid();
    const session = await getSessionFromCtx(ctx);
    if (!session)
      throw new APIError("UNAUTHORIZED", { error: "login_required" });
    return runWithTransaction(ctx.context.adapter, async () => {
      const adapter = await getCurrentAdapter(ctx.context.adapter);
      const tx = authTransaction(adapter);
      await tx.execute(sql`set local lock_timeout = '2s'`);
      const [stored] = await tx
        .select()
        .from(verifications)
        .where(
          and(
            eq(verifications.id, flowId.data),
            eq(verifications.identifier, prefix + flowId.data),
            sql`${verifications.expiresAt} > statement_timestamp()`,
          ),
        )
        .for("update");
      if (!stored) throw invalid();
      const flow = flowSchema.parse(JSON.parse(stored.value));
      if (
        flow.query !== binding(params) ||
        (flow.userId && flow.userId !== session.user.id) ||
        ["complete", "denied"].includes(flow.status)
      )
        throw invalid();
      flow.userId = session.user.id;
      await setDatabaseScope(tx, {
        kind: "policy-user",
        userId: session.user.id,
      });
      const clientId = params.get("client_id")!;
      const resources = params.getAll("resource");
      if (resources.length > 1)
        throw new APIError("BAD_REQUEST", { error: "invalid_target" });
      const resource = resources[0] ?? null;
      const scopes = params.get("scope")?.split(" ").filter(Boolean) ?? [];
      if (action === "continue") {
        const memberId = z.uuid().safeParse(ctx.body.memberId);
        if (
          !memberId.success ||
          !ctx.body.postLogin ||
          flow.status !== "selection"
        )
          throw invalid();
        const grant = await createResourceGrant(
          tx,
          {
            userId: session.user.id,
            sessionId: session.session.id,
            memberId: memberId.data,
            clientId,
            resource,
            scopes,
          },
          options.refreshTokenExpiresIn ?? 2_592_000,
        );
        flow.grantId = grant.id;
        flow.status = "consent";
      }
      let grant: typeof grantContexts.$inferSelect | null = null;
      let acceptedDecision: Extract<
        Awaited<ReturnType<typeof userResourcePolicy>>,
        { allowed: true }
      > | null = null;
      if (flow.grantId) {
        await lockResourceGrantPolicy(adapter, { id: flow.grantId, clientId });
        const decision = await userResourcePolicy(tx, {
          id: flow.grantId,
          clientId,
          resource,
          requestedScopes: scopes,
          grantType: "authorization_code",
        });
        if (
          !decision.allowed ||
          decision.grant.authenticationSessionId !== session.session.id ||
          !(await currentGrantAuthentication(tx, decision.grant))
        )
          throw new APIError("FORBIDDEN", { error: "access_denied" });
        grant = decision.grant;
        acceptedDecision = decision;
      } else if (action === "consent") throw invalid();
      if (action === "details") {
        const [client] = await tx
          .select({
            clientId: oauthClients.clientId,
            name: oauthClients.name,
            uri: oauthClients.uri,
          })
          .from(oauthClients)
          .where(
            and(
              eq(oauthClients.clientId, clientId),
              eq(oauthClients.disabled, false),
              isNull(oauthClients.deletedAt),
            ),
          );
        const [target] =
          resource === null
            ? []
            : await tx
                .select({
                  identifier: oauthResources.identifier,
                  name: oauthResources.name,
                })
                .from(oauthResources)
                .where(
                  and(
                    eq(oauthResources.identifier, resource),
                    eq(oauthResources.disabled, false),
                    isNull(oauthResources.deletedAt),
                  ),
                );
        if (!client || (resource !== null && !target)) throw invalid();
        const memberships = await tx
          .select({
            memberId: members.id,
            organizationId: organizations.id,
            name: organizations.name,
            slug: organizations.slug,
            authenticated: sql<boolean>`exists(select 1 from ${sessions} s
            join ${accounts} a on a.id = s.authentication_account_id and a.user_id = s.user_id and a.deleted_at is null
            join ${ssoProviders} p on p.id = s.authentication_provider_id and p.revision = s.authentication_provider_revision
              and p.organization_id = s.authentication_organization_id and p.issuer = a.issuer and p.provider_id = a.provider_id and p.deleted_at is null
            where s.id = ${session.session.id} and s.user_id = ${session.user.id} and s.expires_at > statement_timestamp()
              and s.authentication_organization_id = ${members.organizationId})`,
          })
          .from(members)
          .innerJoin(
            organizations,
            eq(organizations.id, members.organizationId),
          )
          .where(
            and(
              eq(members.userId, session.user.id),
              isEffective(members),
              eq(organizations.status, "active"),
              isNull(organizations.deletedAt),
            ),
          );
        const selected = flow.grantId
          ? (
              await tx
                .select({ memberId: grantContexts.memberId })
                .from(grantContexts)
                .where(eq(grantContexts.id, flow.grantId))
            )[0]?.memberId
          : null;
        await tx
          .update(verifications)
          .set({ value: JSON.stringify(flow) })
          .where(eq(verifications.id, stored.id));
        return {
          client,
          resource: target ?? null,
          scopes,
          memberships,
          selectedMemberId: selected ?? null,
          status: flow.status,
        };
      }
      const result = await active.run(
        { flow, sessionId: session.session.id },
        () =>
          run({
            ...ctx,
            context: {
              ...ctx.context,
              adapter: { ...ctx.context.adapter, ...adapter },
            },
          }),
      );
      // The native browser endpoint returns a JSON redirect, never a token response.
      const parsed = z.object({ url: z.url() }).parse(result);
      const destination = new URL(parsed.url);
      if (destination.searchParams.has("code")) flow.status = "complete";
      if (action === "consent" && ctx.body.accept === false)
        flow.status = "denied";
      if (grant && (flow.status === "complete" || flow.status === "denied"))
        await recordUserOAuth(tx, {
          grant,
          clientId,
          actor: "user",
          action:
            flow.status === "denied"
              ? "oauth.user.denied"
              : "oauth.user.authorized",
          requestId: ctx.headers?.get("x-request-id"),
          data: {
            scopes: ctx.body.scope?.split(" ").filter(Boolean) ?? scopes,
            decision: acceptedDecision,
          },
        });
      await tx
        .update(verifications)
        .set({ value: JSON.stringify(flow) })
        .where(eq(verifications.id, stored.id));
      return result;
    }).catch(rethrowGrantError);
  }
  return { postLogin, start, resume };
}
