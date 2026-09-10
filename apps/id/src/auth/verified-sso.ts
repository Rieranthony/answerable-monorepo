import { AsyncLocalStorage } from "node:async_hooks";
import type {
  SSOUserResolutionInput,
  SSOUserResolution,
  sso,
} from "@better-auth/sso";
import type { DBTransactionAdapter, BetterAuthPlugin } from "better-auth";
import {
  APIError,
  addOAuthServerContext,
  createAuthEndpoint,
  createAuthMiddleware,
  getOAuthState,
  getSessionFromCtx,
  sessionMiddleware,
} from "better-auth/api";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database, Executor } from "../db/client.ts";
import {
  accounts,
  members,
  organizations,
  sessions,
  ssoProviders,
  users,
} from "../db/schema/index.ts";
import { recordAuditEvent } from "../db/queries/audit.ts";
import { isEffective } from "../db/queries/effective.ts";
import { resolveFederatedUser } from "../services/federation.ts";
import { authTransaction } from "./database-adapter.ts";
import { isFreshAuthentication } from "./fresh-authentication.ts";
import { tenantAuthentication } from "./tenant-authentication.ts";

const flowSchema = z.object({
  purpose: z.enum(["link", "reauthenticate"]),
  userId: z.uuid(),
  sessionId: z.uuid(),
  accountId: z.uuid(),
  organizationId: z.uuid(),
  providerId: z.uuid(),
  providerRevision: z.number().int(),
  targetOrganizationId: z.uuid(),
  targetProviderId: z.uuid(),
  targetProviderRevision: z.number().int(),
  startedAt: z.number().int(),
  expiresAt: z.number().int(),
});
type Flow = z.infer<typeof flowSchema>;
type RequestState = {
  session?: { userId: string; sessionId: string };
  consume?: (identifier: string) => Promise<{ value: string } | null>;
  flow?: Flow;
  flowId?: string;
};
const prefix = "answerable-identity-flow:";
const reject = (code: string): SSOUserResolution => ({
  action: "reject",
  code,
});
function invalid() {
  return new APIError("FORBIDDEN", {
    code: "identity_flow_invalid",
    message: "Start this authentication flow again.",
  });
}

/** Purpose state uses native atomic verification consumption because the OAuth
 * callback itself still uses a separate state lookup and deletion.
 */
export function createVerifiedSso(db: Database) {
  const requests = new AsyncLocalStorage<RequestState>();
  function run<T>(work: () => T) {
    return requests.run({}, work);
  }

  async function observe() {
    const request = requests.getStore();
    if (!request || request.flow) return;
    const id = (await getOAuthState())?.serverContext?.answerableIdentityFlow;
    if (id === undefined) return;
    if (typeof id !== "string" || !request.session || !request.consume)
      throw invalid();
    const claim = await request.consume(`${prefix}${id}`);
    if (!claim) throw invalid();
    const flow = flowSchema.parse(JSON.parse(claim.value));
    if (
      flow.sessionId !== request.session.sessionId ||
      flow.userId !== request.session.userId
    )
      throw invalid();
    request.flow = flow;
    request.flowId = id;
  }

  async function current(tx: Executor, flow: Flow) {
    const source = await tenantAuthentication(tx, {
      userId: flow.userId,
      sessionId: flow.sessionId,
      organizationId: flow.organizationId,
      ...(flow.purpose === "reauthenticate"
        ? { reauthentication: true as const }
        : {}),
    });
    const [target] = await tx
      .select({ id: ssoProviders.id })
      .from(ssoProviders)
      .innerJoin(
        organizations,
        eq(organizations.id, ssoProviders.organizationId),
      )
      .where(
        and(
          eq(ssoProviders.id, flow.targetProviderId),
          eq(ssoProviders.organizationId, flow.targetOrganizationId),
          eq(ssoProviders.revision, flow.targetProviderRevision),
          isNull(ssoProviders.deletedAt),
          isNull(organizations.deletedAt),
          eq(organizations.status, "active"),
        ),
      );
    const time = await tx.execute(
      sql`select statement_timestamp() < ${new Date(flow.expiresAt).toISOString()}::timestamptz as valid`,
    );
    if (
      !source ||
      !target ||
      !time.rows[0]!.valid ||
      source.authenticationAccountId !== flow.accountId ||
      source.authenticationProviderId !== flow.providerId ||
      source.authenticationProviderRevision !== flow.providerRevision
    )
      throw invalid();
    if (
      flow.purpose === "link" &&
      !(await isFreshAuthentication(tx, source.upstreamAuthTime))
    )
      throw new APIError("FORBIDDEN", { code: "reauthentication_required" });
    const [member] = await tx
      .select({ effective: isEffective(members) })
      .from(members)
      .where(
        and(
          eq(members.userId, flow.userId),
          eq(members.organizationId, flow.targetOrganizationId),
        ),
      );
    if (member && !member.effective)
      throw new APIError("FORBIDDEN", { code: "membership_revoked" });
    return source;
  }

  async function beforeTransaction(tx: Executor) {
    const flow = requests.getStore()?.flow;
    if (!flow) return;
    await tx.execute(sql`set local lock_timeout = '2s'`);
    // Acquire our source/target locks before native SSO's provider update lock.
    await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, flow.userId))
      .for("update");
    await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(
        inArray(organizations.id, [
          flow.organizationId,
          flow.targetOrganizationId,
        ]),
      )
      .orderBy(organizations.id)
      .for("share");
    await tx
      .select({ id: ssoProviders.id })
      .from(ssoProviders)
      .where(inArray(ssoProviders.id, [flow.providerId, flow.targetProviderId]))
      .orderBy(ssoProviders.id)
      .for("update");
    await current(tx, flow);
  }

  async function resolve(
    input: SSOUserResolutionInput,
    database: DBTransactionAdapter,
    authTime: Date | null,
  ): Promise<SSOUserResolution | undefined> {
    const request = requests.getStore();
    const flow = request?.flow;
    if (!flow) return;
    const tx = authTransaction(database);
    try {
      await current(tx, flow);
    } catch (error) {
      if (error instanceof APIError) return reject(error.body!.code!);
      throw error;
    }
    const [provider] = await tx
      .select()
      .from(ssoProviders)
      .where(eq(ssoProviders.id, flow.targetProviderId));
    if (
      provider!.providerId !== input.providerId ||
      provider!.issuer !== input.accountKey.issuer
    )
      return reject("identity_flow_invalid");
    if (
      !authTime ||
      authTime.getTime() < Math.floor(flow.startedAt / 1000) * 1000 ||
      !(await isFreshAuthentication(tx, authTime))
    )
      return reject("reauthentication_required");
    if (flow.purpose === "reauthenticate") {
      const [account] = await tx
        .select()
        .from(accounts)
        .where(eq(accounts.id, flow.accountId));
      if (
        account!.issuer !== input.accountKey.issuer ||
        account!.accountId !== input.accountKey.accountId
      )
        return reject("authentication_identity_mismatch");
      return resolveFederatedUser(input, database);
    }
    const resolution = await resolveFederatedUser(input, database, flow.userId);
    if (resolution.action === "reject") return resolution;
    // Provision the membership in this transaction, before binding audit and
    // session creation. Native post-callback provisioning then finds it intact.
    const existing = await database.findOne({
      model: "member",
      where: [
        { field: "userId", value: flow.userId },
        { field: "organizationId", value: flow.targetOrganizationId },
      ],
    });
    if (!existing)
      await database.create({
        model: "member",
        data: {
          userId: flow.userId,
          organizationId: flow.targetOrganizationId,
          role: "member",
          status: "active",
        },
      });
    const [account] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.issuer, input.accountKey.issuer),
          eq(accounts.accountId, input.accountKey.accountId),
        ),
      );
    await recordAuditEvent(tx, {
      schemaVersion: 1,
      actorType: "user",
      actorId: flow.userId,
      organizationId: flow.targetOrganizationId,
      action: "identity.linked",
      targetType: "account",
      targetId: account!.id,
      outcome: "success",
      data: {
        initiatingSessionId: flow.sessionId,
        initiatingAccountId: flow.accountId,
        authenticationProviderId: flow.targetProviderId,
        authenticationProviderRevision: flow.targetProviderRevision,
        upstreamAuthTime: authTime.toISOString(),
        flowId: request!.flowId,
      },
    });
    return resolution;
  }

  async function beforeSession(tx: Executor, authTime: Date | null) {
    const flow = requests.getStore()?.flow;
    if (!flow) return;
    await current(tx, flow);
    if (!(await isFreshAuthentication(tx, authTime)))
      throw new APIError("FORBIDDEN", { code: "reauthentication_required" });
  }

  function plugin(native: ReturnType<typeof sso>): BetterAuthPlugin {
    const signIn = native.endpoints.signInSSO;
    const body = z.object({
      callbackURL: z.url(),
      errorCallbackURL: z.url().optional(),
    });
    function endpoint<Purpose extends "link" | "reauthenticate">(
      purpose: Purpose,
    ) {
      return createAuthEndpoint(
        `/sso/${purpose}`,
        {
          method: "POST",
          body:
            purpose === "link"
              ? body.extend({ providerId: z.string().min(1).max(200) })
              : body,
          // Native global middleware validates Origin and both callback URLs.
          use: [sessionMiddleware],
          metadata: {
            openapi: {
              summary:
                purpose === "link"
                  ? "Bind another work identity"
                  : "Reauthenticate the current work identity",
              description:
                "Requires a current browser session. Requests prompt=login and max_age=0; verified auth_time and exact current identities are checked on return. Follow the returned URL with the same browser cookies.",
              responses: {
                ...signIn.options.metadata.openapi.responses,
                401: { description: "A current browser session is required." },
                403: {
                  description:
                    "identity_flow_invalid: current identity, provider or membership is unavailable. reauthentication_required: verify the initiating identity before linking. membership_revoked: target membership is ineffective. Callback refusals also include identity_conflict and authentication_identity_mismatch; start again after correcting the cause.",
                },
              },
            },
          },
        },
        async (ctx) => {
          const session = ctx.context.session;
          const flow = await db.transaction(async (tx) => {
            await tx
              .select({ id: users.id })
              .from(users)
              .where(eq(users.id, session.user.id))
              .for("share");
            const [stored] = await tx
              .select()
              .from(sessions)
              .where(
                and(
                  eq(sessions.id, session.session.id),
                  eq(sessions.userId, session.user.id),
                ),
              );
            if (!stored?.authenticationOrganizationId) throw invalid();
            const [target] = await tx
              .select()
              .from(ssoProviders)
              .where(
                and(
                  isNull(ssoProviders.deletedAt),
                  purpose === "link"
                    ? eq(
                        ssoProviders.providerId,
                        (ctx.body as { providerId?: string }).providerId!,
                      )
                    : eq(ssoProviders.id, stored.authenticationProviderId!),
                ),
              );
            if (!target) throw invalid();
            await tx
              .select({ id: organizations.id })
              .from(organizations)
              .where(
                inArray(organizations.id, [
                  stored.authenticationOrganizationId,
                  target.organizationId,
                ]),
              )
              .orderBy(organizations.id)
              .for("share");
            const source = await tenantAuthentication(tx, {
              userId: session.user.id,
              sessionId: session.session.id,
              organizationId: stored.authenticationOrganizationId,
              ...(purpose === "reauthenticate"
                ? { reauthentication: true as const }
                : {}),
            });
            if (!source) throw invalid();
            const now = Date.now();
            const flow: Flow = {
              purpose,
              userId: source.userId,
              sessionId: source.authenticationSessionId,
              accountId: source.authenticationAccountId,
              organizationId: source.authenticationOrganizationId,
              providerId: source.authenticationProviderId,
              providerRevision: source.authenticationProviderRevision,
              targetOrganizationId: target.organizationId,
              targetProviderId: target.id,
              targetProviderRevision: target.revision,
              startedAt: now,
              expiresAt: now + 300_000,
            };
            await current(tx, flow);
            return { flow, providerId: target.providerId };
          });
          const id = crypto.randomUUID();
          await ctx.context.internalAdapter.createVerificationValue({
            identifier: `${prefix}${id}`,
            value: JSON.stringify(flow.flow),
            expiresAt: new Date(flow.flow.expiresAt),
          });
          await addOAuthServerContext({ answerableIdentityFlow: id });
          // Calling the native endpoint here keeps its selection, discovery,
          // provider fingerprint, state cookies and URL generation unchanged.
          return signIn({
            ...ctx,
            asResponse: true,
            body: {
              callbackURL: ctx.body.callbackURL,
              errorCallbackURL: ctx.body.errorCallbackURL,
              providerId: flow.providerId,
              providerType: "oidc",
              additionalParams: { prompt: "login", max_age: "0" },
            },
          });
        },
      );
    }
    return {
      id: "answerable-verified-sso",
      endpoints: {
        reauthenticateSso: endpoint("reauthenticate"),
        linkSso: endpoint("link"),
      },
      hooks: {
        before: [
          {
            matcher: (ctx) => ctx.path === "/sso/callback",
            handler: createAuthMiddleware(async (ctx) => {
              const session = await getSessionFromCtx(ctx);
              const request = requests.getStore();
              if (request) {
                request.consume =
                  ctx.context.internalAdapter.consumeVerificationValue;
                if (session)
                  request.session = {
                    userId: session.user.id,
                    sessionId: session.session.id,
                  };
              }
            }),
          },
        ],
      },
    };
  }
  return { run, observe, beforeTransaction, resolve, beforeSession, plugin };
}

export type VerifiedSso = ReturnType<typeof createVerifiedSso>;
