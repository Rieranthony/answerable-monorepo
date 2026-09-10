import { setDatabaseScope, withDatabaseScope } from "../db/isolation.ts";
import { configureRuntimeRole } from "../db/runtime-role.ts";
import {
  putSsoProvider,
  deleteSsoProvider,
} from "../services/sso-providers.ts";
import { lockResourceGrantPolicy } from "./lock-resource-grant-policy.ts";
import { createDatabase, type Database, type Executor } from "../db/client.ts";
import { updateCapability } from "../services/capabilities.ts";
import { createResourceGrant } from "./create-resource-grant.ts";
import { signInThroughIdp } from "../__tests__/federation.ts";
import { createCapability } from "../services/capabilities.ts";
import { userResourcePolicy } from "./user-resource-policy.ts";
import { bindGrantCode, withNativeCodeReplay } from "./native-code-replay.ts";
import {
  updateClient,
  unlinkResource,
  rotateSecret,
  disableClient,
  enableClient,
} from "../services/clients.ts";
import {
  updateResource,
  disableResource,
  enableResource,
} from "../services/resources.ts";
import { revokeUserSession, revokeUserSessions } from "../services/sessions.ts";
import {
  disableOrganization,
  enableOrganization,
} from "../services/organizations.ts";
import {
  inPlatformUsers,
  inPlatformWrite,
} from "../__tests__/platform-context.ts";
import { eraseUser, disableUser, enableUser } from "../services/users.ts";
import { inTenant, inTenantRead } from "../__tests__/tenant-command.ts";
import { memberAccess } from "../db/queries/access.ts";
import {
  remove as removeMember,
  reinstate as reinstateMember,
} from "../services/members.ts";
import { withNativeRefreshFamily } from "./native-refresh-family.ts";
import { withNativeTokenCleanup } from "./native-token-cleanup.ts";
import { withNativeClientAuthentication } from "./native-client-authentication.ts";
import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import {
  betterAuth,
  getCurrentAdapter,
  type BetterAuthOptions,
} from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { jwt } from "better-auth/plugins/jwt";
import {
  getOAuthProviderApi,
  oauthProvider,
} from "@better-auth/oauth-provider";
import { runWithTransaction } from "@better-auth/core/context";
import { and, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { decodeJwt, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createAdminFixture, type AdminFixture } from "../__tests__/admin.ts";
import { authDatabaseAdapter, authTransaction } from "./database-adapter.ts";
import { answerableSchema } from "./answerable-schema.ts";
import {
  members,
  users,
  organizations,
  groupMembers,
  groups,
  accounts,
  ssoProviders,
  entitlements,
  organizationCapabilities,
  sessions,
  oauthClients,
  oauthClientAssertions,
  oauthResources,
  oauthClientResources,
  oauthRefreshTokens,
  oauthAccessTokens,
  grantContexts,
  verifications,
} from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";
import { hashClientSecret } from "../services/client-secrets.ts";

// Provider integration proof only. Production still allows machine grants alone.
// This wrapper proves transaction/context mechanics, not a complete OAuth policy:
// assertion consumption and denial-side revocation must survive rejected issuance.
let fixture: AdminFixture;
let auth: { handler(request: Request): Promise<Response> };
let testAdapter: Parameters<
  typeof getOAuthProviderApi
>[0]["context"]["adapter"];
let runtime: ReturnType<typeof createDatabase>;
const runtimeRole = `id_test_user_broker_${crypto.randomUUID().replaceAll("-", "")}`;
let sessionId: string;
let boundB: { cookie: string; sessionId: string } | undefined;
let selectedMemberId: string | undefined;
const clientId = "user-boundary-proof";
const secret = "user-boundary-proof-secret";
const resource = "https://resource.example/user-boundary";
const redirect = "https://client.example/callback";
const verifier = "v".repeat(64);
let denyIssuance = false;
let issuanceFailure: Error | undefined;
let cleanupFault: { model: string; database: boolean } | undefined;
const issuanceStarted = new WeakSet<object>();
let claimsCalls = 0;
let marker = createId();
type NativeCreate = ReturnType<
  Parameters<Parameters<typeof withNativeClientAuthentication>[3]>[1]
>;
let expiredCreate: NativeCreate;
let inspectBinding = true;
let rejectNested: () => Promise<void>;
let beforePolicy: ((adapter: object) => Promise<void>) | undefined;
let afterPolicy: (() => Promise<void>) | undefined;
let afterAuthentication: (() => Promise<void>) | undefined;

beforeEach(async () => {
  selectedMemberId = undefined;
  boundB = undefined;
  denyIssuance = false;
  issuanceFailure = undefined;
  cleanupFault = undefined;
  claimsCalls = 0;
  marker = createId();
  inspectBinding = true;
  afterAuthentication = undefined;
  afterPolicy = undefined;
  beforePolicy = undefined;
  fixture = await createAdminFixture({ databasePoolMax: 1 });
  await fixture.db.insert(members).values({
    id: createId(),
    userId: fixture.principals.tenantAdmin.userId,
    organizationId: fixture.outsider.organizationId,
  });
  const [session] = await fixture.db
    .select()
    .from(sessions)
    .where(eq(sessions.userId, fixture.principals.tenantAdmin.userId));
  sessionId = session!.id;
  await fixture.db.insert(oauthClients).values({
    id: createId(),
    clientId,
    clientSecret: hashClientSecret(secret),
    name: "User boundary proof",
    organizationId: fixture.tenant.organizationId,
    redirectUris: [redirect],
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    scopes: ["openid", "offline_access", "proof:read"],
    tokenEndpointAuthMethod: "client_secret_basic",
    skipConsent: true,
    requirePKCE: true,
  });
  await fixture.db.insert(oauthResources).values({
    id: createId(),
    identifier: resource,
    name: "User proof",
    allowedScopes: ["openid", "offline_access", "proof:read"],
  });
  await fixture.db
    .insert(oauthClientResources)
    .values({ id: createId(), clientId, resourceId: resource });
  for (const organizationId of [
    fixture.tenant.organizationId,
    fixture.outsider.organizationId,
  ]) {
    await inPlatformWrite(fixture.db, async (context) => {
      for (const input of [
        {
          clientId,
          resource: null,
          grantKind: "authorization_code" as const,
          scopes: ["openid", "offline_access"],
        },
        {
          clientId,
          resource,
          grantKind: "authorization_code" as const,
          scopes: ["proof:read"],
        },
        {
          clientId,
          resource,
          grantKind: "refresh_token" as const,
          scopes: ["proof:read"],
        },
      ])
        await createCapability(context, organizationId, input);
    });
    await fixture.db.insert(entitlements).values([
      {
        id: createId(),
        organizationId,
        clientId,
        resource: null,
        scopes: ["openid", "offline_access"],
      },
      {
        id: createId(),
        organizationId,
        clientId,
        resource,
        scopes: ["proof:read"],
      },
    ]);
  }
  await configureRuntimeRole(fixture.db, runtimeRole);
  const password = crypto.randomUUID().replaceAll("-", "");
  await fixture.db.execute(
    sql.raw(`alter role "${runtimeRole}" login password '${password}'`),
  );
  const runtimeUrl = new URL(fixture.environment.databaseUrl);
  runtimeUrl.username = runtimeRole;
  runtimeUrl.password = password;
  runtime = createDatabase({
    ...fixture.environment,
    databaseUrl: runtimeUrl.toString(),
    databasePoolMax: 1,
  });
  const provider = oauthProvider({
    loginPage: "https://pages.example/login",
    consentPage: "https://pages.example/consent",
    storeClientSecret: "hashed",
    storeTokens: "hashed",
    scopes: ["openid", "offline_access", "proof:read"],
    refreshTokenReuseInterval: 60,
    postLogin: {
      page: "https://pages.example/tenant",
      shouldRedirect: async () => false,
      consentReferenceId: async ({ user, session, scopes }) => {
        const grant = await createResourceGrant(
          runtime.db,
          {
            userId: user.id,
            sessionId: session.id,
            memberId:
              selectedMemberId ?? fixture.principals.tenantAdmin.memberId,
            clientId,
            resource,
            scopes,
          },
          30 * 86400,
        );
        return grant.id;
      },
    },
    extensions: [
      {
        claims: {
          accessToken: async ({
            ctx,
            client,
            referenceId,
            grantType,
            scopes,
          }) => {
            claimsCalls++;
            expect(client.clientId).toBe(clientId);
            expect(referenceId).toBeString();
            expect(["authorization_code", "refresh_token"]).toContain(
              grantType ?? "",
            );
            const adapter = await getCurrentAdapter(ctx.context.adapter);
            issuanceStarted.add(adapter);
            // Refresh already holds these locks from preflight, before its family lock.
            if (grantType === "authorization_code") {
              await beforePolicy?.(adapter);
              await lockResourceGrantPolicy(adapter, {
                id: referenceId!,
                clientId: client.clientId,
              });
            }
            const policy = await userResourcePolicy(authTransaction(adapter), {
              id: referenceId!,
              clientId: client.clientId,
              resource,
              grantType: grantType as "authorization_code" | "refresh_token",
              requestedScopes: scopes,
            });
            const grant = policy.allowed ? policy.grant : null;
            if (!grant)
              throw new APIError("FORBIDDEN", { error: "access_denied" });
            await afterPolicy?.();
            expect(grant.userId).toBe(fixture.principals.tenantAdmin.userId);
            if (grantType === "authorization_code") {
              const codeId = await getOAuthProviderApi(
                ctx,
                provider.options,
              ).hashToken(ctx.body.code, "authorization_code");
              await bindGrantCode(authTransaction(adapter), grant.id, codeId);
            }

            await adapter.create({
              model: "verification",
              data: {
                identifier: marker,
                value: "proof",
                expiresAt: new Date(Date.now() + 60000),
              },
            });
            if (issuanceFailure) throw issuanceFailure;
            if (denyIssuance)
              throw new APIError("FORBIDDEN", { error: "access_denied" });
            return { proof_membership: grant.memberId, proof_grant: grant.id };
          },
        },
      },
    ],
  });
  const token = provider.endpoints.oauth2Token;
  const wrapped = {
    ...provider,
    endpoints: {
      ...provider.endpoints,
      oauth2Token: createAuthEndpoint(
        token.path,
        token.options,
        async (ctx) => {
          if (
            ctx.body.grant_type !== "authorization_code" &&
            ctx.body.grant_type !== "refresh_token"
          )
            throw new APIError("BAD_REQUEST", {
              error: "unsupported_grant_type",
            });
          const kind = ctx.body.grant_type;
          rejectNested = async () => {
            await runWithTransaction(ctx.context.adapter, async () => {
              await expect(
                withNativeClientAuthentication(
                  ctx,
                  provider.options,
                  kind,
                  async () => {
                    throw new Error("Nested authentication must never run");
                  },
                ),
              ).rejects.toThrow("Client authentication requires autocommit");
            });
          };
          return withNativeClientAuthentication(
            ctx,
            provider.options,
            ctx.body.grant_type,
            async (authenticated, nativeCreate) => {
              expect(authenticated.clientId).toBeString();
              const change = afterAuthentication;
              afterAuthentication = undefined;
              await change?.();
              const outcome = await runWithTransaction(
                ctx.context.adapter,
                async () => {
                  const adapter = await getCurrentAdapter(ctx.context.adapter);
                  await setDatabaseScope(authTransaction(adapter), {
                    kind: "grant-client",
                    clientId: authenticated.clientId,
                  });
                  const create = nativeCreate(adapter);
                  expiredCreate = create;
                  if (inspectBinding) {
                    inspectBinding = false;
                    await expect(
                      create({
                        model: "oauthClientAssertion",
                        data: {
                          id: "not-authenticated",
                          expiresAt: new Date(),
                        },
                        forceAllowId: true,
                      }),
                    ).rejects.toMatchObject({ status: "BAD_REQUEST" });
                  }
                  const bound = {
                    ...ctx,
                    context: {
                      ...ctx.context,
                      adapter: {
                        ...ctx.context.adapter,
                        ...adapter,
                        create,
                        deleteMany: async (
                          input: Parameters<typeof adapter.deleteMany>[0],
                        ) => {
                          if (cleanupFault?.model === input.model) {
                            if (cleanupFault.database)
                              await authTransaction(adapter).execute(
                                sql`select 1 / 0`,
                              );
                            throw new Error(
                              "simulated cleanup adapter failure",
                            );
                          }
                          return adapter.deleteMany(input);
                        },
                      },
                    },
                  };
                  let refreshGrant: typeof grantContexts.$inferSelect | null =
                    null;
                  if (ctx.body.grant_type === "refresh_token") {
                    const hash = await getOAuthProviderApi(
                      bound,
                      provider.options,
                    ).hashToken(ctx.body.refresh_token!, "refresh_token");
                    const stored = await adapter.findOne<{
                      referenceId: string;
                      scopes: string[];
                    }>({
                      model: "oauthRefreshToken",
                      where: [{ field: "token", value: hash }],
                    });
                    if (stored) {
                      await lockResourceGrantPolicy(adapter, {
                        id: stored.referenceId,
                        clientId: authenticated.clientId,
                      });
                      await authTransaction(adapter).execute(
                        sql`select id from grant_contexts where id = ${stored.referenceId} for update`,
                      );
                    }
                    const policy = stored
                      ? await userResourcePolicy(authTransaction(adapter), {
                          id: stored.referenceId,
                          clientId: authenticated.clientId,
                          resource,
                          grantType: "refresh_token",
                          requestedScopes:
                            ctx.body.scope?.split(" ").filter(Boolean) ??
                            stored.scopes,
                        })
                      : null;
                    const grant = policy?.allowed ? policy.grant : null;
                    if (!grant)
                      throw new APIError("BAD_REQUEST", {
                        error: "invalid_grant",
                      });
                    refreshGrant = grant;
                  }
                  try {
                    const execute = (
                      nativeAdapter: typeof bound.context.adapter,
                    ) =>
                      withNativeTokenCleanup(nativeAdapter, (deleteMany) =>
                        token({
                          ...bound,
                          context: {
                            ...bound.context,
                            adapter: { ...nativeAdapter, deleteMany },
                          },
                          asResponse: false,
                          returnHeaders: true,
                        }),
                      );
                    const outcome = refreshGrant
                      ? await withNativeRefreshFamily(
                          bound.context.adapter,
                          authTransaction(adapter),
                          {
                            id: refreshGrant.id,
                            clientId: authenticated.clientId,
                            userId: refreshGrant.userId,
                          },
                          execute,
                        )
                      : await withNativeCodeReplay(
                          bound.context.adapter,
                          authTransaction(adapter),
                          {
                            clientId: authenticated.clientId,
                            authorizationCodeId: await getOAuthProviderApi(
                              bound,
                              provider.options,
                            ).hashToken(ctx.body.code!, "authorization_code"),
                          },
                          execute,
                        );
                    if ("error" in outcome) return { error: outcome.error };
                    const result = outcome.value;
                    result.headers.forEach((value, name) =>
                      ctx.setHeader(name, value),
                    );
                    return { response: result.response };
                  } catch (error) {
                    // Pinned-provider proof: code invalid_grant occurs before
                    // issuance; its replay cleanup must commit before throwing.
                    // This is deliberately not a generic "commit on 4xx" rule.
                    if (
                      kind === "authorization_code" &&
                      !issuanceStarted.has(adapter) &&
                      error instanceof APIError &&
                      error.body?.error === "invalid_grant"
                    )
                      return { error };
                    throw error;
                  }
                },
              );
              if ("error" in outcome) throw outcome.error;
              return outcome.response;
            },
          );
        },
      ),
    },
  };
  const authOptions: BetterAuthOptions = {
    baseURL: fixture.environment.betterAuthUrl,
    basePath: "/auth",
    secret: fixture.environment.betterAuthSecret,
    database: authDatabaseAdapter(runtime.db),
    advanced: { database: { generateId: createId } },
    logger: { disabled: true },
    plugins: [
      answerableSchema(),
      jwt({
        jwt: { issuer: fixture.environment.betterAuthUrl },
        schema: { jwks: { modelName: "jwk" } },
      }),
      wrapped,
    ],
  };
  const configuredAuth = betterAuth(authOptions);
  auth = configuredAuth;
  testAdapter = (await configuredAuth.$context).adapter;
});
afterEach(async () => {
  setSystemTime();
  await runtime?.close();
  await fixture.db.execute(sql`drop owned by ${sql.identifier(runtimeRole)}`);
  await fixture.db.execute(sql`drop role ${sql.identifier(runtimeRole)}`);
  await fixture?.close();
});

// Deliberate binding is a fixture, not a production linking journey. Each B grant
// still requires its own native, independently verified B sign-in and session.
async function authenticateB() {
  if (boundB) return boundB;
  const userId = fixture.principals.tenantAdmin.userId;
  await fixture.db
    .insert(accounts)
    .values({
      id: createId(),
      userId,
      issuer: fixture.issuer.origin,
      providerId: "outsider",
      accountId: "bound-b-subject",
    });
  fixture.issuer.enqueue({
    sub: "bound-b-subject",
    email: "bound@outsider.example.com",
    email_verified: true,
  });
  const signedIn = await signInThroughIdp(fixture.app, {
    providerId: "outsider",
    callbackURL: `${fixture.trustedOrigin}/callback`,
  });
  expect(signedIn.location).toBe(`${fixture.trustedOrigin}/callback`);
  const [session] = await fixture.db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, userId),
        eq(
          sessions.authenticationOrganizationId,
          fixture.outsider.organizationId,
        ),
      ),
    );
  boundB = {
    sessionId: session!.id,
    cookie: signedIn.cookies
      .map((cookie) => cookie.split(";", 1)[0])
      .join("; "),
  };
  return boundB;
}

async function currentSsoPolicyInput(executor: Executor = fixture.db) {
  const [provider] = await executor
    .select()
    .from(ssoProviders)
    .where(
      and(
        eq(ssoProviders.organizationId, fixture.tenant.organizationId),
        sql`${ssoProviders.deletedAt} is null`,
      ),
    );
  return {
    issuer: provider!.issuer,
    domain: provider!.domain,
    oidc: JSON.parse(provider!.oidcConfig!),
  };
}

async function authorize(scope = "openid offline_access proof:read") {
  let cookie = fixture.principals.tenantAdmin.cookie;
  if (selectedMemberId) {
    const [member] = await fixture.db
      .select()
      .from(members)
      .where(eq(members.id, selectedMemberId));
    if (
      member?.userId === fixture.principals.tenantAdmin.userId &&
      member.organizationId === fixture.outsider.organizationId
    )
      cookie = (await authenticateB()).cookie;
  }
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: "code",
    scope,
    resource,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: createId(),
  });
  const response = await auth.handler(
    new Request(
      `${fixture.environment.betterAuthUrl}/auth/oauth2/authorize?${query}`,
      { headers: { Cookie: cookie } },
    ),
  );
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location")!);
  expect(location.origin + location.pathname).toBe(redirect);
  const code = location.searchParams.get("code");
  expect(code).toBeString();
  return code!;
}
function redeem(fields: Record<string, string>, clientSecret = secret) {
  return auth.handler(
    new Request(`${fixture.environment.betterAuthUrl}/auth/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(fields),
    }),
  );
}
async function initial() {
  const code = await authorize();
  return redeem({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirect,
    code_verifier: verifier,
    resource,
  });
}

test("native code redemption and refresh preserve server-bound membership despite a supplied tenant", async () => {
  const response = await initial();
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toContain("no-store");
  await expect(
    expiredCreate({
      model: "verification",
      data: { identifier: createId(), value: "late", expiresAt: new Date() },
    }),
  ).rejects.toThrow("Client authentication context has expired");
  const issued = await response.json();
  expect(Object.keys(issued)).toContain("access_token");
  const expectedScopes = ["offline_access", "openid", "proof:read"];
  expect(issued.scope.split(" ").sort()).toEqual(expectedScopes);
  expect(
    decodeJwt(issued.access_token).scope?.toString().split(" ").sort(),
  ).toEqual(expectedScopes);
  await rejectNested();
  expect(decodeJwt(issued.access_token).proof_membership).toBe(
    fixture.principals.tenantAdmin.memberId,
  );
  expect(issued.refresh_token).toBeString();
  await fixture.db
    .update(sessions)
    .set({ activeOrganizationId: fixture.outsider.organizationId })
    .where(eq(sessions.id, sessionId));
  const renewed = await redeem({
    grant_type: "refresh_token",
    refresh_token: issued.refresh_token,
    resource,
    organization: fixture.outsider.organizationId,
  });
  await fixture.db
    .update(sessions)
    .set({ activeOrganizationId: fixture.tenant.organizationId })
    .where(eq(sessions.id, sessionId));
  expect(renewed.status).toBe(200);
  const next = await renewed.json();
  expect(next.scope.split(" ").sort()).toEqual(expectedScopes);
  expect(
    decodeJwt(next.access_token).scope?.toString().split(" ").sort(),
  ).toEqual(expectedScopes);
  expect(decodeJwt(next.access_token).proof_membership).toBe(
    fixture.principals.tenantAdmin.memberId,
  );
  const rows = await fixture.db
    .select()
    .from(oauthRefreshTokens)
    .where(eq(oauthRefreshTokens.clientId, clientId));
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    expect([...row.scopes].sort()).toEqual(expectedScopes);
    expect(row.referenceId).toBe(
      decodeJwt<{ proof_grant: string }>(issued.access_token).proof_grant,
    );
    expect(row.userId).toBe(fixture.principals.tenantAdmin.userId);
    expect(row.authorizationCodeId).toBeString();
    expect(row.sessionId).toBe(sessionId);
    expect(row.authTime).toBeInstanceOf(Date);
    expect(row.authTime).toEqual(rows[0]!.authTime);
    expect(row.authorizationCodeId).toBe(rows[0]!.authorizationCodeId);
    expect(row.resources).toEqual([resource]);
  }
  const beforeReplay = claimsCalls;
  let replay: Response;
  try {
    setSystemTime(new Date(Date.now() + 2000));
    replay = await redeem({
      grant_type: "refresh_token",
      refresh_token: issued.refresh_token,
      resource,
    });
  } finally {
    setSystemTime();
  }
  expect(replay!.status).toBe(200);
  const replayed = await replay!.json();
  expect({ ...replayed, expires_in: next.expires_in }).toEqual(next);
  expect(replayed.expires_in).toBeGreaterThanOrEqual(0);
  expect(replayed.expires_in).toBeLessThan(next.expires_in);
  expect(claimsCalls).toBe(beforeReplay);
  await fixture.db
    .update(members)
    .set({ status: "revoked", revokedAt: new Date() })
    .where(eq(members.id, fixture.principals.tenantAdmin.memberId));
  try {
    const denied = await redeem({
      grant_type: "refresh_token",
      refresh_token: issued.refresh_token,
      resource,
    });
    expect(denied.status).toBe(400);
    expect(await denied.json()).toMatchObject({ error: "invalid_grant" });
    expect(claimsCalls).toBe(beforeReplay);
  } finally {
    await fixture.db
      .update(members)
      .set({ status: "active", revokedAt: null })
      .where(eq(members.id, fixture.principals.tenantAdmin.memberId));
  }
});

test("rejected issuance rolls back the extension write and code consumption for an authenticated basic client", async () => {
  const code = await authorize();
  marker = createId();
  denyIssuance = true;
  try {
    const rejected = await redeem({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
      code_verifier: verifier,
      resource,
    });
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toMatchObject({ error: "access_denied" });
    expect(
      await fixture.db
        .select()
        .from(verifications)
        .where(eq(verifications.identifier, marker)),
    ).toHaveLength(0);
  } finally {
    denyIssuance = false;
  }
  const accepted = await redeem({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirect,
    code_verifier: verifier,
    resource,
  });
  expect(accepted.status).toBe(200);
  expect(
    await fixture.db
      .select()
      .from(verifications)
      .where(eq(verifications.identifier, marker)),
  ).toHaveLength(1);
});

test("a rejected native user grant still consumes its private-key assertion", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  await fixture.db
    .update(oauthClients)
    .set({
      tokenEndpointAuthMethod: "private_key_jwt",
      jwks: JSON.stringify({
        keys: [
          { ...(await exportJWK(publicKey)), kid: "user-proof", alg: "RS256" },
        ],
      }),
    })
    .where(eq(oauthClients.clientId, clientId));
  const code = await authorize();
  const assertion = () =>
    new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "user-proof" })
      .setIssuer(clientId)
      .setSubject(clientId)
      .setAudience(`${fixture.environment.betterAuthUrl}/auth/oauth2/token`)
      .setIssuedAt()
      .setExpirationTime("2m")
      .setJti(createId())
      .sign(privateKey);
  const request = (jwt: string) =>
    auth.handler(
      new Request(`${fixture.environment.betterAuthUrl}/auth/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          client_assertion_type:
            "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: jwt,
          code,
          redirect_uri: redirect,
          code_verifier: verifier,
          resource,
        }),
      }),
    );
  const before = await fixture.db.select().from(oauthClientAssertions);
  const proof = await assertion();
  const callsBefore = claimsCalls;
  denyIssuance = true;
  marker = createId();
  try {
    const rejected = await request(proof);
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toMatchObject({ error: "access_denied" });
    expect(await fixture.db.select().from(oauthClientAssertions)).toHaveLength(
      before.length + 1,
    );
    expect(
      await fixture.db
        .select()
        .from(verifications)
        .where(eq(verifications.identifier, marker)),
    ).toHaveLength(0);
    const duplicate = await request(proof);
    expect(duplicate.status).toBe(400);
    expect(await duplicate.json()).toMatchObject({ error: "invalid_client" });
    expect(claimsCalls).toBe(callsBefore + 1);
    const changedKeyProof = await assertion();
    afterAuthentication = async () => {
      await fixture.db
        .update(oauthClients)
        .set({ jwks: JSON.stringify({ keys: [] }) })
        .where(eq(oauthClients.clientId, clientId));
    };
    const changedKey = await request(changedKeyProof);
    expect(changedKey.status).toBe(401);
    expect(await changedKey.json()).toMatchObject({ error: "invalid_client" });
    expect(claimsCalls).toBe(callsBefore + 1);
    expect(await fixture.db.select().from(oauthClientAssertions)).toHaveLength(
      before.length + 2,
    );
    await fixture.db
      .update(oauthClients)
      .set({
        jwks: JSON.stringify({
          keys: [
            {
              ...(await exportJWK(publicKey)),
              kid: "user-proof",
              alg: "RS256",
            },
          ],
        }),
      })
      .where(eq(oauthClients.clientId, clientId));
    const concurrentProof = await assertion();
    const concurrent = await Promise.all([
      request(concurrentProof),
      request(concurrentProof),
    ]);
    expect(concurrent.map((response) => response.status).sort()).toEqual([
      400, 403,
    ]);
    expect(await fixture.db.select().from(oauthClientAssertions)).toHaveLength(
      before.length + 3,
    );
    expect(claimsCalls).toBe(callsBefore + 2);
    denyIssuance = false;
    const fresh = await request(await assertion());
    expect(fresh.status).toBe(200);
    expect(await fixture.db.select().from(oauthClientAssertions)).toHaveLength(
      before.length + 4,
    );
  } finally {
    denyIssuance = false;
    afterAuthentication = undefined;
    await fixture.db
      .update(oauthClients)
      .set({ tokenEndpointAuthMethod: "client_secret_basic", jwks: null })
      .where(eq(oauthClients.clientId, clientId));
  }
});

test("public native clients still require the user's code and PKCE proof", async () => {
  await fixture.db
    .update(oauthClients)
    .set({ tokenEndpointAuthMethod: "none", clientSecret: null })
    .where(eq(oauthClients.clientId, clientId));
  try {
    const code = await authorize();
    const request = (proof?: string) =>
      auth.handler(
        new Request(`${fixture.environment.betterAuthUrl}/auth/oauth2/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: clientId,
            code,
            redirect_uri: redirect,
            resource,
            ...(proof === undefined ? {} : { code_verifier: proof }),
          }),
        }),
      );
    const before = claimsCalls;
    const missing = await request();
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: "invalid_request" });
    const wrong = await request("w".repeat(64));
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({ error: "invalid_request" });
    expect(claimsCalls).toBe(before);
    const accepted = await request(verifier);
    expect(accepted.status).toBe(200);
    expect(decodeJwt((await accepted.json()).access_token).sub).toBe(
      fixture.principals.tenantAdmin.userId,
    );
  } finally {
    await fixture.db
      .update(oauthClients)
      .set({
        tokenEndpointAuthMethod: "client_secret_basic",
        clientSecret: hashClientSecret(secret),
      })
      .where(eq(oauthClients.clientId, clientId));
  }
});

test("replayed authorization code revokes its refresh tokens without touching another grant", async () => {
  const code = await authorize();
  const fields = {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirect,
    code_verifier: verifier,
    resource,
  };
  const issued = await redeem(fields);
  expect(issued.status).toBe(200);
  const tokens = await issued.json();
  const [otherMember] = await fixture.db
    .select()
    .from(members)
    .where(
      and(
        eq(members.userId, fixture.principals.tenantAdmin.userId),
        eq(members.organizationId, fixture.outsider.organizationId),
      ),
    );
  selectedMemberId = otherMember!.id;
  let unrelated: Response;
  try {
    unrelated = await initial();
  } finally {
    selectedMemberId = undefined;
  }
  expect(unrelated.status).toBe(200);
  const other = await unrelated.json();
  const before = claimsCalls;
  const replay = await redeem(fields);
  expect(replay.status).toBe(400);
  expect(await replay.json()).toMatchObject({ error: "invalid_grant" });
  const id = decodeJwt<{ proof_grant: string }>(
    tokens.access_token,
  ).proof_grant;
  expect(
    (
      await fixture.db
        .select()
        .from(grantContexts)
        .where(eq(grantContexts.id, id))
    )[0]!.revokedAt,
  ).not.toBeNull();

  expect(claimsCalls).toBe(before);
  const revoked = await redeem({
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    resource,
  });
  expect(revoked.status).toBe(400);
  expect(await revoked.json()).toMatchObject({ error: "invalid_grant" });
  expect(claimsCalls).toBe(before);
  const preserved = await redeem({
    grant_type: "refresh_token",
    refresh_token: other.refresh_token,
    resource,
  });
  expect(preserved.status).toBe(200);
});

test("issuance errors never commit extension writes even when shaped as invalid_grant", async () => {
  for (const failure of [
    new APIError("BAD_REQUEST", { error: "invalid_grant" }),
    new Error("simulated signing or audit failure"),
  ]) {
    const code = await authorize();
    const fields = {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
      code_verifier: verifier,
      resource,
    };
    const before = await fixture.db.select().from(oauthRefreshTokens);
    marker = createId();
    issuanceFailure = failure;
    try {
      const rejected = await redeem(fields);
      expect(rejected.status).toBe(failure instanceof APIError ? 400 : 500);
      expect(await fixture.db.select().from(oauthRefreshTokens)).toEqual(
        before,
      );
      expect(
        await fixture.db
          .select()
          .from(verifications)
          .where(eq(verifications.identifier, marker)),
      ).toHaveLength(0);
    } finally {
      issuanceFailure = undefined;
    }
    // Whole issuance rollback still includes code consumption in this proof.
    // Denial-side code consumption needs its own production policy boundary.
    expect((await redeem(fields)).status).toBe(200);
  }
});

test("failed native replay cleanup is retryable and rolls back partial deletion", async () => {
  for (const model of ["oauthAccessToken", "oauthRefreshToken"]) {
    for (const database of [false, true]) {
      const code = await authorize();
      const fields = {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirect,
        code_verifier: verifier,
        resource,
      };
      const existingIds = new Set(
        (await fixture.db.select().from(oauthRefreshTokens)).map(
          (row) => row.id,
        ),
      );
      const issued = await redeem(fields);
      expect(issued.status).toBe(200);
      const tokens = await issued.json();
      const before = await fixture.db.select().from(oauthRefreshTokens);
      const hash = before.find(
        (row) => !existingIds.has(row.id),
      )!.authorizationCodeId!;
      expect(hash).toBeString();
      // Seed a correlated opaque row to prove rollback of the first deletion
      // when the second fails; JWT issuance itself has no access-token row.
      const accessId = createId();
      await fixture.db.insert(oauthAccessTokens).values({
        id: accessId,
        clientId,
        authorizationCodeId: hash,
        scopes: ["proof:read"],
        expiresAt: new Date(Date.now() + 60000),
      });
      expect(before.some((row) => row.authorizationCodeId === hash)).toBe(true);
      const calls = claimsCalls;
      cleanupFault = { model, database };
      try {
        const failed = await redeem(fields);
        expect(failed.status).toBe(503);
        expect(failed.headers.get("Retry-After")).toBe("1");
        expect(await failed.json()).toMatchObject({
          error: "temporarily_unavailable",
        });
        expect(await fixture.db.select().from(oauthRefreshTokens)).toEqual(
          before,
        );
        expect(
          await fixture.db
            .select()
            .from(oauthAccessTokens)
            .where(eq(oauthAccessTokens.id, accessId)),
        ).toHaveLength(1);
        expect(claimsCalls).toBe(calls);
      } finally {
        cleanupFault = undefined;
      }

      const id = decodeJwt<{ proof_grant: string }>(
        tokens.access_token,
      ).proof_grant;
      expect(
        (
          await fixture.db
            .select()
            .from(grantContexts)
            .where(eq(grantContexts.id, id))
        )[0]!.revokedAt,
      ).not.toBeNull();
      expect(
        (
          await redeem({
            grant_type: "refresh_token",
            refresh_token: tokens.refresh_token,
            resource,
          })
        ).status,
      ).toBe(400);
      const retry = await redeem(fields);
      expect(retry.status).toBe(400);
      expect(await retry.json()).toMatchObject({ error: "invalid_grant" });
      expect(
        await fixture.db
          .select()
          .from(oauthAccessTokens)
          .where(eq(oauthAccessTokens.id, accessId)),
      ).toHaveLength(0);
      const denied = await redeem({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        resource,
      });
      expect(denied.status).toBe(400);
      expect(claimsCalls).toBe(calls);
    }
  }
});

test("one user's two tenant grants remain independent and revoked cached refresh cannot return tokens", async () => {
  const first = await initial();
  expect(first.status).toBe(200);
  const a = await first.json();
  const rotated = await redeem({
    grant_type: "refresh_token",
    refresh_token: a.refresh_token,
    resource,
  });
  expect(rotated.status).toBe(200);
  const [otherMember] = await fixture.db
    .select()
    .from(members)
    .where(
      and(
        eq(members.userId, fixture.principals.tenantAdmin.userId),
        eq(members.organizationId, fixture.outsider.organizationId),
      ),
    );
  const memberId = otherMember!.id;
  selectedMemberId = memberId;
  let second: Response;
  try {
    second = await initial();
  } finally {
    selectedMemberId = undefined;
  }
  expect(second!.status).toBe(200);
  const b = await second!.json();
  const aId = decodeJwt<{ proof_grant: string }>(a.access_token).proof_grant;
  const bId = decodeJwt<{ proof_grant: string }>(b.access_token).proof_grant;
  expect(aId).not.toBe(bId);
  expect(decodeJwt(b.access_token).proof_membership).toBe(memberId);
  await fixture.db
    .update(grantContexts)
    .set({ revokedAt: new Date() })
    .where(eq(grantContexts.id, aId));
  const before = claimsCalls;
  const replay = await redeem({
    grant_type: "refresh_token",
    refresh_token: a.refresh_token,
    resource,
  });
  expect(replay.status).toBe(400);
  expect(await replay.json()).toMatchObject({ error: "invalid_grant" });
  expect(claimsCalls).toBe(before);
  expect(
    (
      await redeem({
        grant_type: "refresh_token",
        refresh_token: b.refresh_token,
        resource,
      })
    ).status,
  ).toBe(200);
  await expect(
    fixture.db
      .update(grantContexts)
      .set({ revokedAt: null })
      .where(eq(grantContexts.id, aId))
      .execute(),
  ).rejects.toMatchObject({ cause: { constraint: "grant_context_immutable" } });
});

test("grant provenance cannot be forged or rewritten and expiry denies context lookup", async () => {
  const response = await initial();
  expect(response.status).toBe(200);
  const token = await response.json();
  const id = decodeJwt<{ proof_grant: string }>(token.access_token).proof_grant;
  const [grant] = await fixture.db
    .select()
    .from(grantContexts)
    .where(eq(grantContexts.id, id));
  for (const patch of [
    { organizationId: fixture.outsider.organizationId },
    { authorizationCodeId: null },
    { authorizationCodeId: "replacement" },
    { requestedScopes: ["openid"] },
    { clientInstanceId: createId() },
    { authenticationSessionId: createId() },
    { expiresAt: new Date(Date.now() + 86400000) },
  ]) {
    await expect(
      fixture.db
        .update(grantContexts)
        .set(patch)
        .where(eq(grantContexts.id, id))
        .execute(),
    ).rejects.toMatchObject({
      cause: { constraint: "grant_context_immutable" },
    });
  }
  for (const patch of [
    { organizationId: fixture.outsider.organizationId },
    { authenticationSessionId: createId() },
    { authTime: new Date(0) },
  ]) {
    await expect(
      fixture.db
        .insert(grantContexts)
        .values({ ...grant!, ...patch, id: createId() })
        .execute(),
    ).rejects.toMatchObject({
      cause: { constraint: "grant_context_provenance" },
    });
  }
  const expiredId = createId();
  await fixture.db.insert(grantContexts).values({
    ...grant!,
    id: expiredId,
    authorizationCodeId: null,
    createdAt: new Date(Date.now() - 10000),
    expiresAt: new Date(Date.now() - 1000),
  });
  const evaluate = (target: {
    id: string;
    clientId: string;
    resource: string;
  }) =>
    userResourcePolicy(fixture.db, {
      ...target,
      grantType: "authorization_code",
      requestedScopes: grant!.requestedScopes,
    });
  expect((await evaluate({ id, clientId, resource })).allowed).toBe(true);
  for (const target of [
    { id: expiredId, clientId, resource },
    { id, clientId: "another-client", resource },
    { id, clientId, resource: "https://other.example" },
  ])
    expect(await evaluate(target)).toEqual({
      allowed: false,
      reason: "context",
    });
});

test("native refresh reuse invalidates only its immutable grant family", async () => {
  const a = await (await initial()).json();
  const aNextResponse = await redeem({
    grant_type: "refresh_token",
    refresh_token: a.refresh_token,
    resource,
  });
  expect(aNextResponse.status).toBe(200);
  const aNext = await aNextResponse.json();
  const [otherMember] = await fixture.db
    .select()
    .from(members)
    .where(
      and(
        eq(members.userId, fixture.principals.tenantAdmin.userId),
        eq(members.organizationId, fixture.outsider.organizationId),
      ),
    );
  selectedMemberId = otherMember!.id;
  let b: { refresh_token: string; access_token: string };
  try {
    b = await (await initial()).json();
  } finally {
    selectedMemberId = undefined;
  }
  const aId = decodeJwt<{ proof_grant: string }>(a.access_token).proof_grant;
  const bId = decodeJwt<{ proof_grant: string }>(b!.access_token).proof_grant;
  const before = claimsCalls;
  let reused: Response;
  try {
    setSystemTime(new Date(Date.now() + 61000));
    reused = await redeem({
      grant_type: "refresh_token",
      refresh_token: a.refresh_token,
      resource,
    });
  } finally {
    setSystemTime();
  }
  expect(reused!.status).toBe(400);
  expect(await reused!.json()).toMatchObject({ error: "invalid_grant" });
  expect(claimsCalls).toBe(before);
  const [revoked] = await fixture.db
    .select()
    .from(grantContexts)
    .where(eq(grantContexts.id, aId));
  expect(revoked!.revokedAt).toBeInstanceOf(Date);
  expect(
    await fixture.db
      .select()
      .from(oauthRefreshTokens)
      .where(eq(oauthRefreshTokens.referenceId, aId)),
  ).toHaveLength(0);
  const [untouched] = await fixture.db
    .select()
    .from(grantContexts)
    .where(eq(grantContexts.id, bId));
  expect(untouched!.revokedAt).toBeNull();
  expect(
    (
      await redeem({
        grant_type: "refresh_token",
        refresh_token: aNext.refresh_token,
        resource,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await redeem({
        grant_type: "refresh_token",
        refresh_token: b!.refresh_token,
        resource,
      })
    ).status,
  ).toBe(200);
});

test("refresh-family cleanup outage preserves revocation while restoring token rows", async () => {
  for (const database of [false, true]) {
    const issued = await (await initial()).json();
    const rotatedResponse = await redeem({
      grant_type: "refresh_token",
      refresh_token: issued.refresh_token,
      resource,
    });
    expect(rotatedResponse.status).toBe(200);
    const rotated = await rotatedResponse.json();
    const id = decodeJwt<{ proof_grant: string }>(
      issued.access_token,
    ).proof_grant;
    const before = await fixture.db
      .select()
      .from(oauthRefreshTokens)
      .where(eq(oauthRefreshTokens.referenceId, id));
    const opaqueId = createId();
    await fixture.db.insert(oauthAccessTokens).values({
      id: opaqueId,
      clientId,
      refreshId: before[0]!.id,
      referenceId: id,
      scopes: ["proof:read"],
      expiresAt: new Date(Date.now() + 120000),
    });
    cleanupFault = { model: "oauthRefreshToken", database };
    let failed: Response;
    try {
      setSystemTime(new Date(Date.now() + 61000));
      failed = await redeem({
        grant_type: "refresh_token",
        refresh_token: issued.refresh_token,
        resource,
      });
    } finally {
      setSystemTime();
      cleanupFault = undefined;
    }
    expect(failed!.status).toBe(503);
    expect(failed!.headers.get("Retry-After")).toBe("1");
    expect(await failed!.json()).toMatchObject({
      error: "temporarily_unavailable",
    });
    const [grant] = await fixture.db
      .select()
      .from(grantContexts)
      .where(eq(grantContexts.id, id));
    expect(grant!.revokedAt).toBeInstanceOf(Date);
    expect(
      await fixture.db
        .select()
        .from(oauthRefreshTokens)
        .where(eq(oauthRefreshTokens.referenceId, id)),
    ).toEqual(before);
    expect(
      await fixture.db
        .select()
        .from(oauthAccessTokens)
        .where(eq(oauthAccessTokens.id, opaqueId)),
    ).toHaveLength(1);
    const calls = claimsCalls;
    for (const refresh_token of [issued.refresh_token, rotated.refresh_token]) {
      expect(
        (await redeem({ grant_type: "refresh_token", refresh_token, resource }))
          .status,
      ).toBe(400);
    }
    expect(claimsCalls).toBe(calls);
  }
});

test("a provider success after family invalidation cannot return token material", async () => {
  const issued = await (await initial()).json();
  const id = decodeJwt<{ proof_grant: string }>(
    issued.access_token,
  ).proof_grant;
  const result = await runWithTransaction(testAdapter, async () => {
    const adapter = await getCurrentAdapter(testAdapter);
    await setDatabaseScope(authTransaction(adapter), {
      kind: "grant-client",
      clientId,
    });
    const tx = authTransaction(adapter);
    await tx.execute(
      sql`select id from grant_contexts where id = ${id} for update`,
    );
    return withNativeRefreshFamily(
      { ...testAdapter, ...adapter },
      tx,
      { id, clientId, userId: fixture.principals.tenantAdmin.userId },
      async (scoped) => {
        await scoped.findMany({
          model: "oauthRefreshToken",
          where: [
            { field: "clientId", value: clientId },
            { field: "userId", value: fixture.principals.tenantAdmin.userId },
          ],
        });
        return { access_token: "must-not-escape" };
      },
    );
  });
  expect(result).not.toHaveProperty("value");
  expect(result).toMatchObject({
    error: {
      message: "Native family invalidation unexpectedly returned tokens",
    },
  });
  const [grant] = await fixture.db
    .select()
    .from(grantContexts)
    .where(eq(grantContexts.id, id));
  expect(grant!.revokedAt).toBeInstanceOf(Date);
});

test("membership removal and reinstatement cannot revive native refresh in that tenant", async () => {
  const a = await (await initial()).json();
  const rotated = await redeem({
    grant_type: "refresh_token",
    refresh_token: a.refresh_token,
    resource,
  });
  expect(rotated.status).toBe(200);
  const next = await rotated.json();
  const [otherMember] = await fixture.db
    .select()
    .from(members)
    .where(
      and(
        eq(members.userId, fixture.principals.tenantAdmin.userId),
        eq(members.organizationId, fixture.outsider.organizationId),
      ),
    );
  selectedMemberId = otherMember!.id;
  let b: { refresh_token: string };
  try {
    b = await (await initial()).json();
  } finally {
    selectedMemberId = undefined;
  }
  await inTenant(fixture.db, fixture.tenant.organizationId, (context) =>
    removeMember(context, fixture.principals.tenantAdmin.memberId),
  );
  const before = claimsCalls;
  expect(
    (
      await redeem({
        grant_type: "refresh_token",
        refresh_token: a.refresh_token,
        resource,
      })
    ).status,
  ).toBe(400);
  await inTenant(fixture.db, fixture.tenant.organizationId, (context) =>
    reinstateMember(context, fixture.principals.tenantAdmin.memberId),
  );
  for (const refresh_token of [a.refresh_token, next.refresh_token]) {
    const denied = await redeem({
      grant_type: "refresh_token",
      refresh_token,
      resource,
    });
    expect(denied.status).toBe(400);
    expect(await denied.json()).toMatchObject({ error: "invalid_grant" });
  }
  expect(claimsCalls).toBe(before);
  expect(
    (
      await redeem({
        grant_type: "refresh_token",
        refresh_token: b!.refresh_token,
        resource,
      })
    ).status,
  ).toBe(200);
  expect(
    await fixture.db.select().from(sessions).where(eq(sessions.id, sessionId)),
  ).toHaveLength(1);
});

test("organisation disable and re-enable cannot restore A refresh or revoke B through client ownership", async () => {
  const a = await (await initial()).json();
  const rotatedResponse = await redeem({
    grant_type: "refresh_token",
    refresh_token: a.refresh_token,
    resource,
  });
  expect(rotatedResponse.status).toBe(200);
  const rotated = await rotatedResponse.json();
  const [otherMember] = await fixture.db
    .select()
    .from(members)
    .where(
      and(
        eq(members.userId, fixture.principals.tenantAdmin.userId),
        eq(members.organizationId, fixture.outsider.organizationId),
      ),
    );
  selectedMemberId = otherMember!.id;
  let b: { refresh_token: string };
  try {
    b = await (await initial()).json();
  } finally {
    selectedMemberId = undefined;
  }
  await inPlatformWrite(fixture.db, (context) =>
    disableOrganization(context, fixture.tenant.organizationId),
  );
  const before = claimsCalls;
  expect(
    (
      await redeem({
        grant_type: "refresh_token",
        refresh_token: a.refresh_token,
        resource,
      })
    ).status,
  ).toBe(400);
  expect(claimsCalls).toBe(before);
  // This client is owned by A, but the selected user grant belongs to B.
  expect(
    (
      await redeem({
        grant_type: "refresh_token",
        refresh_token: b!.refresh_token,
        resource,
      })
    ).status,
  ).toBe(200);
  await inPlatformWrite(fixture.db, (context) =>
    enableOrganization(context, fixture.tenant.organizationId),
  );
  const afterB = claimsCalls;
  for (const refresh_token of [a.refresh_token, rotated.refresh_token]) {
    const response = await redeem({
      grant_type: "refresh_token",
      refresh_token,
      resource,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
  }
  expect(claimsCalls).toBe(afterB);
  expect(
    await fixture.db.select().from(sessions).where(eq(sessions.id, sessionId)),
  ).toHaveLength(1);
});

test("global disable and re-enable cannot restore cached refresh grants in either tenant", async () => {
  const a = await (await initial()).json();
  const rotation = await redeem({
    grant_type: "refresh_token",
    refresh_token: a.refresh_token,
    resource,
  });
  expect(rotation.status).toBe(200);
  const next = await rotation.json();
  const [otherMember] = await fixture.db
    .select()
    .from(members)
    .where(
      and(
        eq(members.userId, fixture.principals.tenantAdmin.userId),
        eq(members.organizationId, fixture.outsider.organizationId),
      ),
    );
  selectedMemberId = otherMember!.id;
  let b: { refresh_token: string };
  try {
    b = await (await initial()).json();
  } finally {
    selectedMemberId = undefined;
  }
  const calls = claimsCalls;
  await inPlatformUsers(fixture.db, (context) =>
    disableUser(context, fixture.principals.tenantAdmin.userId),
  );
  await inPlatformUsers(fixture.db, (context) =>
    enableUser(context, fixture.principals.tenantAdmin.userId),
  );
  for (const refresh_token of [
    a.refresh_token,
    next.refresh_token,
    b!.refresh_token,
  ]) {
    const response = await redeem({
      grant_type: "refresh_token",
      refresh_token,
      resource,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
  }
  expect(claimsCalls).toBe(calls);
  expect(
    await fixture.db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, fixture.principals.tenantAdmin.userId)),
  ).toHaveLength(0);
});

for (const mode of ["single", "all"] as const) {
  test(`administrative ${mode} session revocation blocks native refresh across its tenant grants`, async () => {
    const a = await (await initial()).json();
    const rotatedResponse = await redeem({
      grant_type: "refresh_token",
      refresh_token: a.refresh_token,
      resource,
    });
    expect(rotatedResponse.status).toBe(200);
    const rotated = await rotatedResponse.json();
    const [otherMember] = await fixture.db
      .select()
      .from(members)
      .where(
        and(
          eq(members.userId, fixture.principals.tenantAdmin.userId),
          eq(members.organizationId, fixture.outsider.organizationId),
        ),
      );
    selectedMemberId = otherMember!.id;
    let b: { refresh_token: string };
    try {
      b = await (await initial()).json();
    } finally {
      selectedMemberId = undefined;
    }
    await inPlatformUsers(fixture.db, async (context) => {
      if (mode === "single")
        await revokeUserSession(
          context,
          fixture.principals.tenantAdmin.userId,
          sessionId,
        );
      else
        await revokeUserSessions(
          context,
          fixture.principals.tenantAdmin.userId,
        );
    });
    const before = claimsCalls;
    for (const refresh_token of [
      a.refresh_token,
      rotated.refresh_token,
      ...(mode === "all" ? [b!.refresh_token] : []),
    ]) {
      const response = await redeem({
        grant_type: "refresh_token",
        refresh_token,
        resource,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_grant" });
    }
    expect(claimsCalls).toBe(before);
    if (mode === "single")
      expect(
        (
          await redeem({
            grant_type: "refresh_token",
            refresh_token: b!.refresh_token,
            resource,
          })
        ).status,
      ).toBe(200);
    expect(
      await fixture.db
        .select()
        .from(sessions)
        .where(eq(sessions.id, sessionId)),
    ).toHaveLength(0);
  });
}

test("resource disable and re-enable deny cached and rotated refresh in both tenants", async () => {
  const a = await (await initial()).json();
  const rotatedResponse = await redeem({
    grant_type: "refresh_token",
    refresh_token: a.refresh_token,
    resource,
  });
  expect(rotatedResponse.status).toBe(200);
  const rotated = await rotatedResponse.json();
  const [otherMember] = await fixture.db
    .select()
    .from(members)
    .where(
      and(
        eq(members.userId, fixture.principals.tenantAdmin.userId),
        eq(members.organizationId, fixture.outsider.organizationId),
      ),
    );
  selectedMemberId = otherMember!.id;
  let b: { refresh_token: string };
  try {
    b = await (await initial()).json();
  } finally {
    selectedMemberId = undefined;
  }
  await inPlatformWrite(fixture.db, (context) =>
    disableResource(context, resource),
  );
  await inPlatformWrite(fixture.db, (context) =>
    enableResource(context, resource),
  );
  const before = claimsCalls;
  for (const refresh_token of [
    a.refresh_token,
    rotated.refresh_token,
    b!.refresh_token,
  ]) {
    const response = await redeem({
      grant_type: "refresh_token",
      refresh_token,
      resource,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
  }
  expect(claimsCalls).toBe(before);
  expect(
    await fixture.db.select().from(sessions).where(eq(sessions.id, sessionId)),
  ).toHaveLength(1);
});

test("client disable and re-enable deny cached and rotated refresh in both tenants", async () => {
  const a = await (await initial()).json();
  const rotatedResponse = await redeem({
    grant_type: "refresh_token",
    refresh_token: a.refresh_token,
    resource,
  });
  expect(rotatedResponse.status).toBe(200);
  const rotated = await rotatedResponse.json();
  const [otherMember] = await fixture.db
    .select()
    .from(members)
    .where(
      and(
        eq(members.userId, fixture.principals.tenantAdmin.userId),
        eq(members.organizationId, fixture.outsider.organizationId),
      ),
    );
  selectedMemberId = otherMember!.id;
  let b: { refresh_token: string };
  try {
    b = await (await initial()).json();
  } finally {
    selectedMemberId = undefined;
  }
  await inPlatformWrite(fixture.db, (context) =>
    disableClient(context, clientId),
  );
  await inPlatformWrite(fixture.db, (context) =>
    enableClient(context, clientId),
  );
  const before = claimsCalls;
  for (const refresh_token of [
    a.refresh_token,
    rotated.refresh_token,
    b!.refresh_token,
  ]) {
    const response = await redeem({
      grant_type: "refresh_token",
      refresh_token,
      resource,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
  }
  expect(claimsCalls).toBe(before);
  expect(
    await fixture.db.select().from(sessions).where(eq(sessions.id, sessionId)),
  ).toHaveLength(1);
});

test("secret rotation denies old tenant refresh grants even with the new credential", async () => {
  const a = await (await initial()).json();
  const rotatedResponse = await redeem({
    grant_type: "refresh_token",
    refresh_token: a.refresh_token,
    resource,
  });
  expect(rotatedResponse.status).toBe(200);
  const rotated = await rotatedResponse.json();
  const [otherMember] = await fixture.db
    .select()
    .from(members)
    .where(
      and(
        eq(members.userId, fixture.principals.tenantAdmin.userId),
        eq(members.organizationId, fixture.outsider.organizationId),
      ),
    );
  selectedMemberId = otherMember!.id;
  let b: { refresh_token: string };
  try {
    b = await (await initial()).json();
  } finally {
    selectedMemberId = undefined;
  }
  const credential = await inPlatformWrite(fixture.db, (context) =>
    rotateSecret(context, clientId),
  );
  const before = claimsCalls;
  for (const refresh_token of [
    a.refresh_token,
    rotated.refresh_token,
    b!.refresh_token,
  ]) {
    const response = await redeem(
      {
        grant_type: "refresh_token",
        refresh_token,
        resource,
      },
      credential.clientSecret,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
  }
  expect(claimsCalls).toBe(before);
  expect(
    await fixture.db.select().from(sessions).where(eq(sessions.id, sessionId)),
  ).toHaveLength(1);
  expect(
    (
      await redeem({
        grant_type: "refresh_token",
        refresh_token: a.refresh_token,
        resource,
      })
    ).status,
  ).toBe(401);
  const code = await authorize();
  expect(
    (
      await redeem(
        {
          grant_type: "authorization_code",
          code,
          redirect_uri: redirect,
          code_verifier: verifier,
          resource,
        },
        credential.clientSecret,
      )
    ).status,
  ).toBe(200);
});

for (const kind of ["authorization_code", "refresh_token"] as const)
  test(`secret rotation after initial client authentication denies in-flight ${kind}`, async () => {
    const fields: Record<string, string> =
      kind === "authorization_code"
        ? {
            grant_type: kind,
            code: await authorize(),
            redirect_uri: redirect,
            code_verifier: verifier,
            resource,
          }
        : {
            grant_type: kind,
            refresh_token: (await (await initial()).json())
              .refresh_token as string,
            resource,
          };
    const writer = createDatabase(fixture.environment);
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    afterAuthentication = async () => {
      entered.resolve();
      await resume.promise;
    };
    const before = claimsCalls;
    const issued = redeem(fields);
    let credential: Awaited<ReturnType<typeof rotateSecret>>;
    try {
      await entered.promise;
      credential = await inPlatformWrite(writer.db, (context) =>
        rotateSecret(context, clientId),
      );
    } finally {
      resume.resolve();
      await issued;
      afterAuthentication = undefined;
      await writer.close();
    }
    const response = await issued;
    expect(response.status).toBe(kind === "authorization_code" ? 401 : 400);
    expect(await response.json()).toMatchObject({
      error: kind === "authorization_code" ? "invalid_client" : "invalid_grant",
    });
    expect(claimsCalls).toBe(before);
    const retained = await fixture.db.select().from(oauthRefreshTokens);
    expect(retained).toHaveLength(kind === "authorization_code" ? 0 : 1);
    expect(retained.every((token) => token.revoked !== null)).toBe(true);
    expect(
      (await fixture.db.select().from(grantContexts)).every(
        (grant) => grant.revokedAt !== null,
      ),
    ).toBe(true);
    // Fresh credentials cannot restore a grant invalidated by the rotation.
    expect((await redeem(fields, credential!.clientSecret)).status).toBe(
      kind === "authorization_code" ? 403 : 400,
    );
    const fresh = await authorize();
    expect(
      (
        await redeem(
          {
            grant_type: "authorization_code",
            code: fresh,
            redirect_uri: redirect,
            code_verifier: verifier,
            resource,
          },
          credential!.clientSecret,
        )
      ).status,
    ).toBe(200);
  });

test("code replay revokes its context after all native token rows have disappeared", async () => {
  const code = await authorize();
  const fields = {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirect,
    code_verifier: verifier,
    resource,
  };
  const response = await redeem(fields);
  expect(response.status).toBe(200);
  const tokens = await response.json();
  const id = decodeJwt<{ proof_grant: string }>(
    tokens.access_token,
  ).proof_grant;
  await fixture.db
    .delete(oauthRefreshTokens)
    .where(eq(oauthRefreshTokens.referenceId, id));
  const replay = await redeem(fields);
  expect(replay.status).toBe(400);
  expect(
    (
      await fixture.db
        .select()
        .from(grantContexts)
        .where(eq(grantContexts.id, id))
    )[0]!.revokedAt,
  ).not.toBeNull();
});

test("code binding rejects missing contexts and duplicate code identity", async () => {
  const tokens = await (await initial()).json();
  const id = decodeJwt<{ proof_grant: string }>(
    tokens.access_token,
  ).proof_grant;
  const [grant] = await fixture.db
    .select()
    .from(grantContexts)
    .where(eq(grantContexts.id, id));
  expect(grant!.authorizationCodeId).toBeString();
  const [stored] = await fixture.db
    .select()
    .from(oauthRefreshTokens)
    .where(eq(oauthRefreshTokens.referenceId, id));
  expect(grant!.authorizationCodeId).toBe(stored!.authorizationCodeId);

  await expect(
    bindGrantCode(fixture.db, createId(), "missing"),
  ).rejects.toMatchObject({ body: { error: "invalid_grant" } });
  await expect(
    fixture.db
      .insert(grantContexts)
      .values({ ...grant!, id: createId() })
      .execute(),
  ).rejects.toMatchObject({
    cause: { constraint: "grant_contexts_authorization_code_id_unique" },
  });
  const freshId = createId();
  await fixture.db
    .insert(grantContexts)
    .values({ ...grant!, id: freshId, authorizationCodeId: null });
  await expect(
    fixture.db
      .update(grantContexts)
      .set({ authorizationCodeId: "" })
      .where(eq(grantContexts.id, freshId))
      .execute(),
  ).rejects.toMatchObject({
    cause: { constraint: "grant_contexts_code_check" },
  });
  await fixture.db
    .update(grantContexts)
    .set({ revokedAt: new Date() })
    .where(eq(grantContexts.id, freshId));
  await expect(
    bindGrantCode(fixture.db, freshId, "late-binding"),
  ).rejects.toMatchObject({ body: { error: "invalid_grant" } });
  await expect(
    fixture.db
      .update(grantContexts)
      .set({ authorizationCodeId: "late-binding" })
      .where(eq(grantContexts.id, freshId))
      .execute(),
  ).rejects.toMatchObject({ cause: { constraint: "grant_context_immutable" } });
});

test("another authenticated client cannot revoke a code's grant or token rows", async () => {
  const code = await authorize();
  const fields = {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirect,
    code_verifier: verifier,
    resource,
  };
  const issued = await redeem(fields);
  expect(issued.status).toBe(200);
  const tokens = await issued.json();
  const id = decodeJwt<{ proof_grant: string }>(
    tokens.access_token,
  ).proof_grant;
  const before = await fixture.db.select().from(oauthRefreshTokens);
  const otherClient = "code-replay-other-client";
  await fixture.db.insert(oauthClients).values({
    id: createId(),
    clientId: otherClient,
    clientSecret: hashClientSecret(secret),
    tokenEndpointAuthMethod: "client_secret_basic",
    redirectUris: [redirect],
    grantTypes: ["authorization_code"],
    scopes: ["openid", "offline_access", "proof:read"],
  });
  const replay = await auth.handler(
    new Request(`${fixture.environment.betterAuthUrl}/auth/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${otherClient}:${secret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(fields),
    }),
  );
  expect(replay.status).toBe(400);
  expect(await fixture.db.select().from(oauthRefreshTokens)).toEqual(before);
  expect(
    (
      await fixture.db
        .select()
        .from(grantContexts)
        .where(eq(grantContexts.id, id))
    )[0]!.revokedAt,
  ).toBeNull();
  expect(
    (
      await redeem({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        resource,
      })
    ).status,
  ).toBe(200);
});

test("unexpected success during code cleanup cannot release tokens or restore its grant", async () => {
  const issued = await (await initial()).json();
  const id = decodeJwt<{ proof_grant: string }>(
    issued.access_token,
  ).proof_grant;
  const [grant] = await fixture.db
    .select()
    .from(grantContexts)
    .where(eq(grantContexts.id, id));
  const before = await fixture.db.select().from(oauthRefreshTokens);
  const result = await runWithTransaction(testAdapter, async () => {
    const adapter = await getCurrentAdapter(testAdapter);
    await setDatabaseScope(authTransaction(adapter), {
      kind: "grant-client",
      clientId,
    });
    return withNativeCodeReplay(
      { ...testAdapter, ...adapter },
      authTransaction(adapter),
      { clientId, authorizationCodeId: grant!.authorizationCodeId! },
      async (scoped) => {
        await scoped.deleteMany({
          model: "oauthRefreshToken",
          where: [
            {
              field: "authorizationCodeId",
              value: grant!.authorizationCodeId!,
            },
          ],
        });
        await scoped.deleteMany({
          model: "verification",
          where: [{ field: "identifier", value: marker }],
        });
        return { access_token: "must-not-escape" };
      },
    );
  });
  expect(result).not.toHaveProperty("value");
  expect(result).toMatchObject({
    error: { message: "Native code replay unexpectedly returned tokens" },
  });
  expect(await fixture.db.select().from(oauthRefreshTokens)).toEqual(before);
  expect(
    await fixture.db
      .select()
      .from(verifications)
      .where(eq(verifications.identifier, marker)),
  ).toHaveLength(1);

  expect(
    (
      await fixture.db
        .select()
        .from(grantContexts)
        .where(eq(grantContexts.id, id))
    )[0]!.revokedAt,
  ).not.toBeNull();
});

test("JWT-only code issuance retains replay authority without refresh or access-token rows", async () => {
  const code = await authorize("openid proof:read");
  const fields = {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirect,
    code_verifier: verifier,
    resource,
  };
  const response = await redeem(fields);
  expect(response.status).toBe(200);
  const token = await response.json();
  expect(token.refresh_token).toBeUndefined();
  expect(await fixture.db.select().from(oauthRefreshTokens)).toHaveLength(0);
  expect(await fixture.db.select().from(oauthAccessTokens)).toHaveLength(0);
  const id = decodeJwt<{ proof_grant: string }>(token.access_token).proof_grant;
  expect((await redeem(fields)).status).toBe(400);
  expect(
    (
      await fixture.db
        .select()
        .from(grantContexts)
        .where(eq(grantContexts.id, id))
    )[0]!.revokedAt,
  ).not.toBeNull();
});

test("native user issuance requires an exact pair assignment despite client login permission", async () => {
  await fixture.db
    .delete(entitlements)
    .where(
      and(
        eq(entitlements.organizationId, fixture.tenant.organizationId),
        eq(entitlements.clientId, clientId),
        eq(entitlements.resource, resource),
      ),
    );
  expect((await initial()).status).toBe(403);
  const [otherMember] = await fixture.db
    .select()
    .from(members)
    .where(
      and(
        eq(members.userId, fixture.principals.tenantAdmin.userId),
        eq(members.organizationId, fixture.outsider.organizationId),
      ),
    );
  selectedMemberId = otherMember!.id;
  expect((await initial()).status).toBe(200);
});

test("cached refresh rechecks renewal capability before claims run", async () => {
  const issued = await (await initial()).json();
  const fields = {
    grant_type: "refresh_token",
    refresh_token: issued.refresh_token,
    resource,
  };
  expect((await redeem(fields)).status).toBe(200);
  await fixture.db
    .delete(organizationCapabilities)
    .where(
      and(
        eq(
          organizationCapabilities.organizationId,
          fixture.tenant.organizationId,
        ),
        eq(organizationCapabilities.clientId, clientId),
        eq(organizationCapabilities.grantKind, "refresh_token"),
      ),
    );
  const before = claimsCalls;
  expect((await redeem(fields)).status).toBe(400);
  expect(claimsCalls).toBe(before);
});

for (const mode of [
  "login",
  "login-scope",
  "pair",
  "expired",
  "future",
  "compatibility",
  "empty-vocabulary",
  "resource-only",
  "other-client",
  "scope",
] as const) {
  test(`native user policy denies ${mode} authority substitution`, async () => {
    const tenant = fixture.tenant.organizationId;
    if (mode === "login-scope")
      await fixture.db
        .update(organizationCapabilities)
        .set({ scopes: ["offline_access"] })
        .where(
          and(
            eq(organizationCapabilities.organizationId, tenant),
            eq(organizationCapabilities.clientId, clientId),
            sql`${organizationCapabilities.resource} is null`,
          ),
        );
    if (mode === "future")
      await fixture.db
        .update(organizationCapabilities)
        .set({ validFrom: new Date(Date.now() + 60000) })
        .where(
          and(
            eq(organizationCapabilities.organizationId, tenant),
            eq(organizationCapabilities.clientId, clientId),
            eq(organizationCapabilities.resource, resource),
          ),
        );
    if (mode === "compatibility") {
      const issued = await (await initial()).json();
      const id = decodeJwt<{ proof_grant: string }>(
        issued.access_token,
      ).proof_grant;
      await fixture.db
        .delete(oauthClientResources)
        .where(
          and(
            eq(oauthClientResources.clientId, clientId),
            eq(oauthClientResources.resourceId, resource),
          ),
        );
      expect(
        await userResourcePolicy(fixture.db, {
          id,
          clientId,
          resource,
          grantType: "refresh_token",
          requestedScopes: ["proof:read"],
        }),
      ).toMatchObject({
        allowed: false,
        reason: "context",
        subject: { userId: fixture.principals.tenantAdmin.userId },
        resource: { identifier: resource },
      });
      const calls = claimsCalls;
      expect(
        (
          await redeem({
            grant_type: "refresh_token",
            refresh_token: issued.refresh_token,
            resource,
          })
        ).status,
      ).toBe(400);
      expect(claimsCalls).toBe(calls);
      return;
    }
    if (mode === "empty-vocabulary")
      await fixture.db
        .update(oauthResources)
        .set({ allowedScopes: null })
        .where(eq(oauthResources.identifier, resource));
    if (mode === "login")
      await fixture.db
        .delete(organizationCapabilities)
        .where(
          and(
            eq(organizationCapabilities.organizationId, tenant),
            eq(organizationCapabilities.clientId, clientId),
            sql`${organizationCapabilities.resource} is null`,
          ),
        );
    if (mode === "pair")
      await fixture.db
        .delete(organizationCapabilities)
        .where(
          and(
            eq(organizationCapabilities.organizationId, tenant),
            eq(organizationCapabilities.clientId, clientId),
            eq(organizationCapabilities.resource, resource),
            eq(organizationCapabilities.grantKind, "authorization_code"),
          ),
        );
    if (mode === "expired")
      await fixture.db
        .update(organizationCapabilities)
        .set({ validUntil: new Date(Date.now() - 1000) })
        .where(
          and(
            eq(organizationCapabilities.organizationId, tenant),
            eq(organizationCapabilities.clientId, clientId),
            eq(organizationCapabilities.resource, resource),
          ),
        );
    if (mode === "scope")
      await fixture.db
        .update(entitlements)
        .set({ scopes: ["unapproved:scope"] })
        .where(
          and(
            eq(entitlements.organizationId, tenant),
            eq(entitlements.clientId, clientId),
            eq(entitlements.resource, resource),
          ),
        );
    if (mode === "resource-only" || mode === "other-client") {
      await fixture.db
        .delete(entitlements)
        .where(
          and(
            eq(entitlements.organizationId, tenant),
            eq(entitlements.clientId, clientId),
            eq(entitlements.resource, resource),
          ),
        );
      const otherClientId = "other-policy-client";
      if (mode === "other-client")
        await fixture.db.insert(oauthClients).values({
          id: createId(),
          clientId: otherClientId,
          redirectUris: [],
          scopes: ["proof:read"],
        });
      await fixture.db.insert(entitlements).values({
        id: createId(),
        organizationId: tenant,
        clientId: mode === "other-client" ? otherClientId : null,
        resource,
        scopes: ["proof:read"],
      });
    }
    expect((await initial()).status).toBe(403);
    expect(await fixture.db.select().from(oauthRefreshTokens)).toHaveLength(0);
  });
}

test("narrowed native refresh cannot regain identity scopes from the original grant", async () => {
  const issued = await (await initial()).json();
  const narrowed = await redeem({
    grant_type: "refresh_token",
    refresh_token: issued.refresh_token,
    resource,
    scope: "proof:read",
  });
  expect(narrowed.status).toBe(200);
  const next = await narrowed.json();
  expect(next.scope).toBe("proof:read");
  expect(decodeJwt(next.access_token).scope).toBe("proof:read");
  expect(next.id_token).toBeUndefined();
  expect(next.refresh_token).toBeString();
  const before = await fixture.db.select().from(oauthRefreshTokens);
  const widened = await redeem({
    grant_type: "refresh_token",
    refresh_token: next.refresh_token,
    resource,
    scope: "openid offline_access proof:read",
  });
  expect(widened.status).toBe(400);
  expect(await widened.json()).toMatchObject({ error: "invalid_scope" });
  expect(await fixture.db.select().from(oauthRefreshTokens)).toEqual(before);
  const renewed = await redeem({
    grant_type: "refresh_token",
    refresh_token: next.refresh_token,
    resource,
  });
  expect(renewed.status).toBe(200);
  const final = await renewed.json();
  expect(final.scope).toBe("proof:read");
  expect(decodeJwt(final.access_token).scope).toBe("proof:read");
  expect(final.id_token).toBeUndefined();
  expect(final.refresh_token).toBeUndefined();
});

test("native resource filtering precedes code claims policy evaluation", async () => {
  const code = await authorize();
  await fixture.db
    .update(oauthResources)
    .set({ allowedScopes: ["proof:read"] })
    .where(eq(oauthResources.identifier, resource));
  const response = await redeem({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirect,
    code_verifier: verifier,
    resource,
  });
  expect(response.status).toBe(200);
  const issued = await response.json();
  expect(issued.scope).toBe("proof:read");
  expect(decodeJwt(issued.access_token).scope).toBe("proof:read");
  expect(issued.id_token).toBeUndefined();
  // The original request included offline_access, so native code issuance still
  // creates a refresh token even though the resulting scope set excludes it.
  expect(issued.refresh_token).toBeString();
  const rows = await fixture.db.select().from(oauthRefreshTokens);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.scopes).toEqual(["proof:read"]);
});

test("user policy decision preserves exact sources and rejects widening its original context", async () => {
  const issued = await (await initial()).json();
  const id = decodeJwt<{ proof_grant: string }>(
    issued.access_token,
  ).proof_grant;
  const decision = await userResourcePolicy(fixture.db, {
    id,
    clientId,
    resource,
    grantType: "refresh_token",
    requestedScopes: ["openid", "offline_access", "proof:read"],
  });
  expect(decision.allowed).toBe(true);
  if (!decision.allowed) throw new Error("Expected an allowed decision");
  expect(decision).toMatchObject({
    reason: "approved",
    grantType: "refresh_token",
    subjectType: "user",
    organization: { id: decision.grant.organizationId },
    subject: {
      userId: decision.grant.userId,
      memberId: decision.grant.memberId,
    },
    client: { id: decision.grant.clientInstanceId, clientId },
    resource: { id: decision.grant.resourceInstanceId, identifier: resource },
    requestedScopes: ["offline_access", "openid", "proof:read"],
  });
  expect(decision.scopes).toEqual(["proof:read"]);
  expect(decision.evidence.capabilities).toHaveLength(3);
  expect(decision.evidence.assignments).toHaveLength(2);
  expect(decision.evidence.evaluatedAt).toBeString();
  const view = await inTenantRead(
    fixture.db,
    decision.grant.organizationId,
    "memberAccess",
    (context) => memberAccess(context, decision.grant.memberId),
  );
  const explanation = view.targets.find(
    (target) =>
      target.kind === "client_resource" &&
      target.id === clientId &&
      target.resource === resource,
  )?.permission;
  expect(explanation?.allowed).toBe(true);
  if (!explanation?.allowed)
    throw new Error("Expected an allowed pair explanation");
  expect(explanation).toMatchObject({
    reason: "approved",
    grantType: "authorization_code",
    requestedScopes: null,
    organization: decision.organization,
    subject: decision.subject,
    client: decision.client,
    resource: decision.resource,
  });
  expect(explanation.scopes).toEqual(decision.scopes);
  expect(explanation.evidence.assignments).toEqual(
    decision.evidence.assignments,
  );
  expect(explanation.evidence.capabilities).toEqual(
    decision.evidence.capabilities.filter(
      (capability) => capability.grantKind === "authorization_code",
    ),
  );
  expect(explanation.evidence.membership).toEqual(decision.evidence.membership);
  const loginExplanation = view.targets.find(
    (target) => target.kind === "client" && target.id === clientId,
  )!.permission;
  expect(loginExplanation.allowed).toBe(true);
  if (!loginExplanation.allowed) throw new Error("Expected login admission");
  expect(loginExplanation.evidence.capabilities).toEqual(
    decision.evidence.capabilities.filter(
      (capability) => capability.resource === null,
    ),
  );
  expect(loginExplanation.evidence.assignments).toEqual(
    decision.evidence.assignments.filter(
      (assignment) => assignment.resource === null,
    ),
  );

  const denied = await userResourcePolicy(fixture.db, {
    id,
    clientId,
    resource,
    grantType: "refresh_token",
    requestedScopes: ["proof:wider"],
  });
  expect(denied).toMatchObject({
    allowed: false,
    reason: "scope",
    grantType: "refresh_token",
    scopes: [],
    organization: decision.organization,
    subject: decision.subject,
    client: decision.client,
    resource: decision.resource,
    requestedScopes: ["proof:wider"],
    evidence: { policyVersion: 1, membership: decision.evidence.membership },
  });
  expect(
    await userResourcePolicy(fixture.db, {
      id: createId(),
      clientId,
      resource,
      grantType: "refresh_token",
      requestedScopes: ["proof:read"],
    }),
  ).toEqual({ allowed: false, reason: "context" });
});

test("group-derived pair permission records its membership evidence and stops when the group is disabled", async () => {
  const organizationId = fixture.tenant.organizationId,
    groupId = createId(),
    membershipId = createId();
  await fixture.db
    .delete(entitlements)
    .where(
      and(
        eq(entitlements.organizationId, organizationId),
        eq(entitlements.clientId, clientId),
        eq(entitlements.resource, resource),
      ),
    );
  await fixture.db.insert(groups).values({
    id: groupId,
    organizationId,
    slug: "policy-group",
    name: "Policy group",
  });
  await fixture.db.insert(groupMembers).values({
    id: membershipId,
    organizationId,
    groupId,
    memberId: fixture.principals.tenantAdmin.memberId,
  });
  await fixture.db.insert(entitlements).values({
    id: createId(),
    organizationId,
    groupId,
    clientId,
    resource,
    scopes: ["proof:read"],
  });
  const response = await initial();
  expect(response.status).toBe(200);
  const issued = await response.json();
  const id = decodeJwt<{ proof_grant: string }>(
    issued.access_token,
  ).proof_grant;
  const decision = await userResourcePolicy(fixture.db, {
    id,
    clientId,
    resource,
    grantType: "refresh_token",
    requestedScopes: ["openid", "offline_access", "proof:read"],
  });
  expect(decision.allowed).toBe(true);
  if (!decision.allowed) throw new Error("Expected group permission");
  expect(
    decision.evidence.assignments.find(
      (source) => source.resource === resource,
    ),
  ).toMatchObject({
    groupId,
    groupMembership: {
      id: membershipId,
      revision: 1,
      groupRevision: 1,
      validFrom: null,
      validUntil: null,
    },
  });
  expect(
    (
      await redeem({
        grant_type: "refresh_token",
        refresh_token: issued.refresh_token,
        resource,
      })
    ).status,
  ).toBe(200);
  await fixture.db
    .update(groups)
    .set({ status: "disabled" })
    .where(eq(groups.id, groupId));
  const calls = claimsCalls;
  expect(
    (
      await redeem({
        grant_type: "refresh_token",
        refresh_token: issued.refresh_token,
        resource,
      })
    ).status,
  ).toBe(400);
  expect(claimsCalls).toBe(calls);
});

test("native context records the actual authenticated session and requested scope maximum", async () => {
  await authorize("openid proof:read");
  const [context] = await fixture.db.select().from(grantContexts);
  expect(context!.requestedScopes).toEqual(["openid", "proof:read"]);
  expect(context!.authenticationSessionId).toBe(sessionId);
  expect(
    await userResourcePolicy(fixture.db, {
      id: context!.id,
      clientId,
      resource,
      grantType: "refresh_token",
      requestedScopes: ["openid", "offline_access", "proof:read"],
    }),
  ).toMatchObject({ allowed: false, reason: "scope" });
});

const creationChanges = [
  "unlink",
  "remove-member",
  "disable-user",
  "disable-tenant",
  "revoke-session",
  "revoke-all-sessions",
  "disable-client",
  "disable-resource",
  "erase-owner",
] as const;
type CreationChange = (typeof creationChanges)[number];
async function creationClient(change: CreationChange) {
  if (change !== "erase-owner") return clientId;
  const ownedClient = `creation-owned-${createId()}`;
  await fixture.db.insert(oauthClients).values({
    id: createId(),
    clientId: ownedClient,
    userId: fixture.principals.outsider.userId,
    redirectUris: [],
    grantTypes: ["authorization_code"],
    scopes: ["openid", "proof:read"],
  });
  await fixture.db
    .insert(oauthClientResources)
    .values({ id: createId(), clientId: ownedClient, resourceId: resource });
  return ownedClient;
}
async function changeCreationAuthority(
  db: Database,
  change: CreationChange,
  targetClient: string,
  before: (tx: Executor) => Promise<void>,
  after: () => Promise<void>,
) {
  const userId = fixture.principals.tenantAdmin.userId;
  if (
    change === "disable-user" ||
    change === "revoke-session" ||
    change === "revoke-all-sessions"
  ) {
    return inPlatformUsers(db, async (context) => {
      await before(context.tx);
      if (change === "disable-user") await disableUser(context, userId);
      else if (change === "revoke-session")
        await revokeUserSession(context, userId, sessionId);
      else await revokeUserSessions(context, userId);
      await after();
    });
  }
  return inPlatformWrite(db, async (context) => {
    await before(context.tx);
    if (change === "unlink")
      await unlinkResource(context, targetClient, resource);
    else if (change === "remove-member")
      await inTenant(context.tx, fixture.tenant.organizationId, (tenant) =>
        removeMember(tenant, fixture.principals.tenantAdmin.memberId),
      );
    else if (change === "disable-tenant")
      await disableOrganization(context, fixture.tenant.organizationId);
    else if (change === "disable-client")
      await disableClient(context, targetClient);
    else if (change === "disable-resource")
      await disableResource(context, resource);
    else
      await eraseUser(
        context,
        fixture.principals.outsider.userId,
        fixture.principals.outsider.userId,
      );
    await after();
  });
}

for (const change of creationChanges)
  test(`${change} committing first prevents waiting resource grant creation`, async () => {
    const targetClient = await creationClient(change);
    const writer = createDatabase({
      ...fixture.environment,
      databasePoolMax: 2,
    });
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const creatorEntered = Promise.withResolvers<void>();
    let creatorPid = 0;
    const changed = changeCreationAuthority(
      writer.db,
      change,
      targetClient,
      async () => {},
      async () => {
        entered.resolve();
        await resume.promise;
      },
    );
    let created: Promise<unknown> | undefined;
    try {
      await entered.promise;
      created = fixture.db
        .transaction(async (tx) => {
          const result = await tx.execute(sql`select pg_backend_pid() as pid`);
          creatorPid = Number(result.rows[0]!.pid);
          creatorEntered.resolve();
          return createResourceGrant(
            tx,
            {
              userId: fixture.principals.tenantAdmin.userId,
              sessionId,
              memberId: fixture.principals.tenantAdmin.memberId,
              clientId: targetClient,
              resource,
              scopes: ["openid", "proof:read"],
            },
            60,
          );
        })
        .then(
          (grant) => grant,
          (error: unknown) => error,
        );
      await creatorEntered.promise;
      let blocked = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        const result = await writer.db.execute(
          sql`select cardinality(pg_blocking_pids(${creatorPid})) > 0 as blocked`,
        );
        if (result.rows[0]!.blocked) {
          blocked = true;
          break;
        }
        await Bun.sleep(10);
      }
      expect(blocked).toBe(true);
    } finally {
      resume.resolve();
      await changed;
      await created;
      await writer.close();
    }
    expect(await created).toMatchObject({ body: { error: "access_denied" } });
    expect(await fixture.db.select().from(grantContexts)).toHaveLength(0);
  });

for (const change of creationChanges)
  test(`resource grant creation commits before ${change} and later policy denies the stored context`, async () => {
    const targetClient = await creationClient(change);
    const writer = createDatabase({
      ...fixture.environment,
      databasePoolMax: 2,
    });
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const writerEntered = Promise.withResolvers<void>();
    let writerPid = 0;
    const created = fixture.db.transaction(async (tx) => {
      const grant = await createResourceGrant(
        tx,
        {
          userId: fixture.principals.tenantAdmin.userId,
          sessionId,
          memberId: fixture.principals.tenantAdmin.memberId,
          clientId: targetClient,
          resource,
          scopes: ["openid", "proof:read"],
        },
        60,
      );
      entered.resolve();
      await resume.promise;
      return grant;
    });
    let changed: Promise<unknown> | undefined;
    try {
      await entered.promise;
      changed = changeCreationAuthority(
        writer.db,
        change,
        targetClient,
        async (tx) => {
          const result = await tx.execute(sql`select pg_backend_pid() as pid`);
          writerPid = Number(result.rows[0]!.pid);
          writerEntered.resolve();
        },
        async () => {},
      );
      await writerEntered.promise;
      let blocked = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        const result = await writer.db.execute(
          sql`select cardinality(pg_blocking_pids(${writerPid})) > 0 as blocked`,
        );
        if (result.rows[0]!.blocked) {
          blocked = true;
          break;
        }
        await Bun.sleep(10);
      }
      expect(blocked).toBe(true);
    } finally {
      resume.resolve();
      await created;
      await changed;
      await writer.close();
    }
    const grant = await created;
    const stored = await fixture.db.select().from(grantContexts);
    if (change === "erase-owner") {
      expect(stored).toMatchObject([{ revokedAt: expect.any(Date) }]);
      expect(
        await fixture.db
          .select()
          .from(oauthClients)
          .where(eq(oauthClients.clientId, targetClient)),
      ).toMatchObject([
        { deletedAt: expect.any(Date), disabled: true, clientSecret: null },
      ]);
    } else {
      expect(stored).toHaveLength(1);
      expect(stored[0]!.revokedAt !== null).toBe(change !== "unlink");
    }
    expect(
      await userResourcePolicy(fixture.db, {
        id: grant.id,
        clientId: targetClient,
        resource,
        grantType: "authorization_code",
        requestedScopes: ["openid", "proof:read"],
      }),
    ).toMatchObject({ allowed: false });
  });

test("resource grant creation times out without partial state and retries after the writer commits", async () => {
  const writer = createDatabase(fixture.environment);
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const input = {
    userId: fixture.principals.tenantAdmin.userId,
    sessionId,
    memberId: fixture.principals.tenantAdmin.memberId,
    clientId,
    resource,
    scopes: ["openid", "proof:read"],
  };
  const held = writer.db.transaction(async (tx) => {
    await tx
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.clientId, clientId))
      .for("update");
    entered.resolve();
    await resume.promise;
  });
  try {
    await entered.promise;
    await expect(
      createResourceGrant(fixture.db, input, 60),
    ).rejects.toMatchObject({
      status: "SERVICE_UNAVAILABLE",
      body: { error: "temporarily_unavailable" },
    });
    expect(await fixture.db.select().from(grantContexts)).toHaveLength(0);
  } finally {
    resume.resolve();
    await held;
    await writer.close();
  }
  const grant = await createResourceGrant(fixture.db, input, 60);
  expect(grant.clientInstanceId).toBeString();
  expect(await fixture.db.select().from(grantContexts)).toHaveLength(1);
});

test("resource grant creation rejects missing or mismatched provenance without creating context rows", async () => {
  const input = {
    userId: fixture.principals.tenantAdmin.userId,
    sessionId,
    memberId: fixture.principals.tenantAdmin.memberId,
    clientId,
    resource,
    scopes: ["openid", "proof:read"],
  };
  for (const patch of [
    { userId: fixture.principals.platformAdmin.userId },
    { memberId: fixture.principals.platformAdmin.memberId },
    { sessionId: createId() },
    { clientId: "unknown-client" },
    { resource: "https://missing.example/resource" },
    { scopes: [] },
    { scopes: ["not-registered"] },
  ]) {
    await expect(
      createResourceGrant(fixture.db, { ...input, ...patch }, 60),
    ).rejects.toMatchObject({ body: { error: "access_denied" } });
    expect(await fixture.db.select().from(grantContexts)).toHaveLength(0);
  }
  for (const lifetime of [0, -1, 1.5, Infinity])
    await expect(
      createResourceGrant(fixture.db, input, lifetime),
    ).rejects.toThrow("Grant lifetime must be a positive integer");
  const grant = await createResourceGrant(
    fixture.db,
    { ...input, scopes: ["proof:read", "openid", "proof:read"] },
    60,
  );
  expect(grant.requestedScopes).toEqual(["openid", "proof:read"]);
  expect(grant.organizationId).toBe(fixture.tenant.organizationId);
  expect(grant.expiresAt.getTime() - grant.createdAt.getTime()).toBe(60000);
});

for (const invalidation of [
  "expired-member",
  "expired-session",
  "disabled-user",
  "disabled-tenant",
  "disabled-client",
  "disabled-resource",
  "unsupported-grant",
  "missing-scopes",
  "foreign-private-resource",
] as const) {
  test(`resource grant creation rejects ${invalidation} before inserting provenance`, async () => {
    const userId = fixture.principals.tenantAdmin.userId;
    const memberId = fixture.principals.tenantAdmin.memberId;
    let target = resource;
    switch (invalidation) {
      case "expired-member":
        await fixture.db
          .update(members)
          .set({ validUntil: new Date(Date.now() - 1000) })
          .where(eq(members.id, memberId));
        break;
      case "expired-session":
        await fixture.db
          .update(sessions)
          .set({ expiresAt: new Date(Date.now() - 1000) })
          .where(eq(sessions.id, sessionId));
        break;
      case "disabled-user":
        await fixture.db
          .update(users)
          .set({ status: "disabled", disabledAt: new Date() })
          .where(eq(users.id, userId));
        break;
      case "disabled-tenant":
        await fixture.db
          .update(organizations)
          .set({ status: "disabled", disabledAt: new Date() })
          .where(eq(organizations.id, fixture.tenant.organizationId));
        break;
      case "disabled-client":
        await fixture.db
          .update(oauthClients)
          .set({ disabled: true })
          .where(eq(oauthClients.clientId, clientId));
        break;
      case "disabled-resource":
        await fixture.db
          .update(oauthResources)
          .set({ disabled: true })
          .where(eq(oauthResources.identifier, resource));
        break;
      case "unsupported-grant":
        await fixture.db
          .update(oauthClients)
          .set({ grantTypes: ["refresh_token"] })
          .where(eq(oauthClients.clientId, clientId));
        break;
      case "missing-scopes":
        await fixture.db
          .update(oauthClients)
          .set({ scopes: null })
          .where(eq(oauthClients.clientId, clientId));
        break;
      case "foreign-private-resource":
        target = `https://${createId()}.example/private`;
        await fixture.db.insert(oauthResources).values({
          id: createId(),
          identifier: target,
          name: "Private",
          classification: "tenant_owned",
          organizationId: fixture.outsider.organizationId,
        });
        await fixture.db
          .insert(oauthClientResources)
          .values({ id: createId(), clientId, resourceId: target });
        break;
    }
    await expect(
      createResourceGrant(
        fixture.db,
        {
          userId,
          sessionId,
          memberId,
          clientId,
          resource: target,
          scopes: ["openid", "proof:read"],
        },
        60,
      ),
    ).rejects.toMatchObject({ body: { error: "access_denied" } });
    expect(await fixture.db.select().from(grantContexts)).toHaveLength(0);
  });
}

for (const kind of ["authorization_code", "refresh_token"] as const)
  for (const change of [
    "capability",
    "client-scopes",
    "resource-scopes",
    "unlink",
    "disable-client",
    "disable-resource",
    "rotate-secret",
    "sso-create",
    "sso-update",
    "sso-delete",
  ] as const)
    test(`native ${kind} issuance holds policy until commit before ${change}`, async () => {
      if (change === "sso-update" || change === "sso-delete")
        await inPlatformWrite(fixture.db, async (context) =>
          putSsoProvider(
            context,
            fixture.tenant.organizationId,
            await currentSsoPolicyInput(context.tx),
          ),
        );
      const writer = createDatabase({
        ...fixture.environment,
        databasePoolMax: 2,
      });
      const [capability] = await fixture.db
        .select()
        .from(organizationCapabilities)
        .where(
          and(
            eq(
              organizationCapabilities.organizationId,
              fixture.tenant.organizationId,
            ),
            eq(organizationCapabilities.clientId, clientId),
            eq(organizationCapabilities.resource, resource),
            eq(organizationCapabilities.grantKind, "authorization_code"),
          ),
        );
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const writerEntered = Promise.withResolvers<void>();
      const existing =
        kind === "refresh_token" ? await (await initial()).json() : null;
      afterPolicy = async () => {
        entered.resolve();
        await resume.promise;
      };
      const issued =
        kind === "authorization_code"
          ? initial()
          : redeem({
              grant_type: "refresh_token",
              refresh_token: existing.refresh_token,
              resource,
            });
      let changed: Promise<unknown> | undefined;
      let writerPid = 0;
      let refreshToken: string;
      let currentSecret = secret;
      try {
        await entered.promise;
        changed = inPlatformWrite(writer.db, async (context) => {
          const result = await context.tx.execute(
            sql`select pg_backend_pid() as pid`,
          );
          writerPid = Number(result.rows[0]!.pid);
          writerEntered.resolve();
          if (change === "rotate-secret") {
            currentSecret = (await rotateSecret(context, clientId))
              .clientSecret;
            return;
          }
          if (change === "sso-delete")
            return deleteSsoProvider(context, fixture.tenant.organizationId);
          if (change === "sso-create" || change === "sso-update")
            return putSsoProvider(context, fixture.tenant.organizationId, {
              ...ssoPolicyInput,
              domain: "changed.example.com",
            });
          if (change === "client-scopes")
            return updateClient(context, clientId, {
              scopes: ["openid", "offline_access"],
            });
          if (change === "resource-scopes")
            return updateResource(context, resource, {
              allowedScopes: ["unrelated"],
            });
          if (change === "disable-client")
            return disableClient(context, clientId);
          if (change === "disable-resource")
            return disableResource(context, resource);
          if (change === "unlink")
            return unlinkResource(context, clientId, resource);
          return updateCapability(
            context,
            capability!.organizationId,
            capability!.id,
            { status: "disabled" },
            capability!,
          );
        });
        await writerEntered.promise;
        let blocked = false;
        for (let attempt = 0; attempt < 50; attempt++) {
          const result = await writer.db.execute(
            sql`select cardinality(pg_blocking_pids(${writerPid})) > 0 as blocked`,
          );
          if (result.rows[0]!.blocked) {
            blocked = true;
            break;
          }
          await Bun.sleep(10);
        }
        expect(blocked).toBe(true);
      } finally {
        resume.resolve();
        await changed;
        const response = await issued;
        expect(response.status).toBe(200);
        refreshToken = (await response.json()).refresh_token;
        afterPolicy = undefined;
        await writer.close();
      }
      expect(
        (
          await redeem(
            {
              grant_type: "refresh_token",
              refresh_token: refreshToken!,
              resource,
            },
            currentSecret,
          )
        ).status,
      ).toBe(change === "disable-client" ? 401 : 400);
    });

for (const target of ["user", "tenant", "client", "resource"] as const)
  test(`native ${target} lock contention is retryable without consuming the code`, async () => {
    const code = await authorize();
    const writer = createDatabase({
      ...fixture.environment,
      databasePoolMax: 1,
    });
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const held = writer.db.transaction(async (tx) => {
      if (target === "user")
        await tx
          .select()
          .from(users)
          .where(eq(users.id, fixture.principals.tenantAdmin.userId))
          .for("update");
      else if (target === "tenant")
        await tx
          .select()
          .from(organizations)
          .where(eq(organizations.id, fixture.tenant.organizationId))
          .for("update");
      else if (target === "client")
        await tx
          .select()
          .from(oauthClients)
          .where(eq(oauthClients.clientId, clientId))
          .for("update");
      else
        await tx
          .select()
          .from(oauthResources)
          .where(eq(oauthResources.identifier, resource))
          .for("update");
      entered.resolve();
      await resume.promise;
    });
    try {
      await entered.promise;
      const response = await redeem({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirect,
        code_verifier: verifier,
        resource,
      });
      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("1");
      expect(await response.json()).toMatchObject({
        error: "temporarily_unavailable",
      });
      expect(await fixture.db.select().from(oauthRefreshTokens)).toHaveLength(
        0,
      );
    } finally {
      resume.resolve();
      await held;
      await writer.close();
    }
    expect(
      (
        await redeem({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirect,
          code_verifier: verifier,
          resource,
        })
      ).status,
    ).toBe(200);
  });

for (const change of [
  "capability",
  "client-scopes",
  "resource-scopes",
  "unlink",
  "disable-client",
  "disable-resource",
  "sso-create",
  "sso-update",
  "sso-delete",
] as const)
  test(`${change} committing first prevents waiting native issuance`, async () => {
    if (change === "sso-update" || change === "sso-delete")
      await inPlatformWrite(fixture.db, async (context) =>
        putSsoProvider(
          context,
          fixture.tenant.organizationId,
          await currentSsoPolicyInput(context.tx),
        ),
      );
    const code = await authorize();
    const writer = createDatabase({
      ...fixture.environment,
      databasePoolMax: 2,
    });
    const [capability] = await fixture.db
      .select()
      .from(organizationCapabilities)
      .where(
        and(
          eq(
            organizationCapabilities.organizationId,
            fixture.tenant.organizationId,
          ),
          eq(organizationCapabilities.clientId, clientId),
          eq(organizationCapabilities.resource, resource),
          eq(organizationCapabilities.grantKind, "authorization_code"),
        ),
      );
    const writerEntered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const issuerEntered = Promise.withResolvers<void>();
    let issuerPid = 0;
    beforePolicy = async (adapter) => {
      const result = await authTransaction(adapter).execute(
        sql`select pg_backend_pid() as pid`,
      );
      issuerPid = Number(result.rows[0]!.pid);
      issuerEntered.resolve();
    };
    const changed = inPlatformWrite(writer.db, async (context) => {
      if (change === "sso-delete")
        await deleteSsoProvider(context, fixture.tenant.organizationId);
      else if (change === "sso-create" || change === "sso-update")
        await putSsoProvider(context, fixture.tenant.organizationId, {
          ...ssoPolicyInput,
          domain: "changed.example.com",
        });
      else if (change === "client-scopes")
        await updateClient(context, clientId, {
          scopes: ["openid", "offline_access"],
        });
      else if (change === "resource-scopes")
        await updateResource(context, resource, {
          allowedScopes: ["unrelated"],
        });
      else if (change === "unlink")
        await unlinkResource(context, clientId, resource);
      else if (change === "disable-client")
        await disableClient(context, clientId);
      else if (change === "disable-resource")
        await disableResource(context, resource);
      else
        await updateCapability(
          context,
          capability!.organizationId,
          capability!.id,
          { status: "disabled" },
          capability!,
        );
      writerEntered.resolve();
      await resume.promise;
    });
    let issued: Promise<Response> | undefined;
    try {
      await writerEntered.promise;
      issued = redeem({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirect,
        code_verifier: verifier,
        resource,
      });
      await issuerEntered.promise;
      let blocked = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        const result = await writer.db.execute(
          sql`select cardinality(pg_blocking_pids(${issuerPid})) > 0 as blocked`,
        );
        if (result.rows[0]!.blocked) {
          blocked = true;
          break;
        }
        await Bun.sleep(10);
      }
      expect(blocked).toBe(true);
    } finally {
      resume.resolve();
      await changed;
      const response = await issued;
      expect(response!.status).toBe(403);
      beforePolicy = undefined;
      await writer.close();
    }
    expect(await fixture.db.select().from(oauthRefreshTokens)).toHaveLength(0);
    await expect(
      lockResourceGrantPolicy({}, { id: createId(), clientId }),
    ).rejects.toThrow("An active authentication transaction is required");
  });

for (const change of ["disable", "session", "all-sessions"] as const)
  for (const kind of ["authorization_code", "refresh_token"] as const)
    test(`${change} waits for approved native ${kind} issuance to commit`, async () => {
      const writer = createDatabase({
        ...fixture.environment,
        databasePoolMax: 2,
      });
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const writerEntered = Promise.withResolvers<void>();
      let writerPid = 0;
      const existing =
        kind === "refresh_token" ? await (await initial()).json() : null;
      let refreshToken: string;
      afterPolicy = async () => {
        entered.resolve();
        await resume.promise;
      };
      const issued =
        kind === "authorization_code"
          ? initial()
          : redeem({
              grant_type: "refresh_token",
              refresh_token: existing.refresh_token,
              resource,
            });
      let changed: Promise<unknown> | undefined;
      try {
        await entered.promise;
        changed = inPlatformUsers(writer.db, async (context) => {
          const result = await context.tx.execute(
            sql`select pg_backend_pid() as pid`,
          );
          writerPid = Number(result.rows[0]!.pid);
          writerEntered.resolve();
          if (change === "session")
            return revokeUserSession(
              context,
              fixture.principals.tenantAdmin.userId,
              sessionId,
            );
          if (change === "all-sessions")
            return revokeUserSessions(
              context,
              fixture.principals.tenantAdmin.userId,
            );
          return disableUser(context, fixture.principals.tenantAdmin.userId);
        });
        await writerEntered.promise;
        let blocked = false;
        for (let attempt = 0; attempt < 50; attempt++) {
          const result = await writer.db.execute(
            sql`select cardinality(pg_blocking_pids(${writerPid})) > 0 as blocked`,
          );
          if (result.rows[0]!.blocked) {
            blocked = true;
            break;
          }
          await Bun.sleep(10);
        }
        expect(blocked).toBe(true);
      } finally {
        resume.resolve();
        await changed;
        const response = await issued;
        afterPolicy = undefined;
        await writer.close();
        expect(response.status).toBe(200);
        refreshToken = (await response.json()).refresh_token;
      }
      expect(
        (
          await redeem({
            grant_type: "refresh_token",
            refresh_token: refreshToken!,
            resource,
          })
        ).status,
      ).toBe(400);
    });

test("erasing a client owner waits for another user's locked grant before cascading the client", async () => {
  const ownerId = fixture.principals.outsider.userId;
  const ownedClient = `owned-${createId()}`;
  await fixture.db.insert(oauthClients).values({
    id: createId(),
    clientId: ownedClient,
    userId: ownerId,
    redirectUris: [],
    grantTypes: ["authorization_code"],
    scopes: ["openid", "proof:read"],
  });
  await fixture.db
    .insert(oauthClientResources)
    .values({ id: createId(), clientId: ownedClient, resourceId: resource });
  const grant = await createResourceGrant(
    fixture.db,
    {
      userId: fixture.principals.tenantAdmin.userId,
      memberId: fixture.principals.tenantAdmin.memberId,
      sessionId,
      clientId: ownedClient,
      resource,
      scopes: ["openid", "proof:read"],
    },
    60,
  );
  const writer = createDatabase({ ...fixture.environment, databasePoolMax: 2 });
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const writerEntered = Promise.withResolvers<void>();
  let writerPid = 0;
  const held = testAdapter.transaction(async (adapter) => {
    await setDatabaseScope(authTransaction(adapter), {
      kind: "grant-client",
      clientId: ownedClient,
    });
    await lockResourceGrantPolicy(adapter, {
      id: grant.id,
      clientId: ownedClient,
    });
    entered.resolve();
    await resume.promise;
    await bindGrantCode(authTransaction(adapter), grant.id, createId());
  });
  let erased: Promise<unknown> | undefined;
  try {
    await entered.promise;
    erased = inPlatformWrite(writer.db, async (context) => {
      const result = await context.tx.execute(
        sql`select pg_backend_pid() as pid`,
      );
      writerPid = Number(result.rows[0]!.pid);
      writerEntered.resolve();
      await eraseUser(context, ownerId, ownerId);
    });
    await writerEntered.promise;
    let blocked = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      const result = await writer.db.execute(
        sql`select cardinality(pg_blocking_pids(${writerPid})) > 0 as blocked`,
      );
      if (result.rows[0]!.blocked) {
        blocked = true;
        break;
      }
      await Bun.sleep(10);
    }
    expect(blocked).toBe(true);
    expect(
      await writer.db
        .select()
        .from(grantContexts)
        .where(eq(grantContexts.id, grant.id)),
    ).toHaveLength(1);
  } finally {
    resume.resolve();
    await held;
    await erased;
    await writer.close();
  }
  expect(
    await fixture.db
      .select()
      .from(grantContexts)
      .where(eq(grantContexts.id, grant.id)),
  ).toMatchObject([{ id: grant.id, revokedAt: expect.any(Date) }]);
  expect(
    await fixture.db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.clientId, ownedClient)),
  ).toMatchObject([
    { deletedAt: expect.any(Date), disabled: true, clientSecret: null },
  ]);
});

for (const change of ["disable", "session", "all-sessions"] as const)
  test(`${change} committing first denies waiting native issuance`, async () => {
    const code = await authorize();
    const writer = createDatabase({
      ...fixture.environment,
      databasePoolMax: 2,
    });
    const writerEntered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const issuerEntered = Promise.withResolvers<void>();
    let issuerPid = 0;
    beforePolicy = async (adapter) => {
      const result = await authTransaction(adapter).execute(
        sql`select pg_backend_pid() as pid`,
      );
      issuerPid = Number(result.rows[0]!.pid);
      issuerEntered.resolve();
    };
    const changed = inPlatformUsers(writer.db, async (context) => {
      if (change === "session")
        await revokeUserSession(
          context,
          fixture.principals.tenantAdmin.userId,
          sessionId,
        );
      else if (change === "all-sessions")
        await revokeUserSessions(
          context,
          fixture.principals.tenantAdmin.userId,
        );
      else await disableUser(context, fixture.principals.tenantAdmin.userId);
      writerEntered.resolve();
      await resume.promise;
    });
    let issued: Promise<Response> | undefined;
    try {
      await writerEntered.promise;
      issued = redeem({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirect,
        code_verifier: verifier,
        resource,
      });
      await issuerEntered.promise;
      let blocked = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        const result = await writer.db.execute(
          sql`select cardinality(pg_blocking_pids(${issuerPid})) > 0 as blocked`,
        );
        if (result.rows[0]!.blocked) {
          blocked = true;
          break;
        }
        await Bun.sleep(10);
      }
      expect(blocked).toBe(true);
    } finally {
      resume.resolve();
      await changed;
      const response = await issued;
      beforePolicy = undefined;
      await writer.close();
      expect(response!.status).toBe(403);
    }
    expect(await fixture.db.select().from(oauthRefreshTokens)).toHaveLength(0);
  });

test("ordinary native sign-out preserves delegation while later administrative revocation stops it", async () => {
  const issued = await (await initial()).json();
  const nextResponse = await redeem({
    grant_type: "refresh_token",
    refresh_token: issued.refresh_token,
    resource,
  });
  expect(nextResponse.status).toBe(200);
  const next = await nextResponse.json();
  const signedOut = await auth.handler(
    new Request(`${fixture.environment.betterAuthUrl}/auth/sign-out`, {
      method: "POST",
      headers: {
        Cookie: fixture.principals.tenantAdmin.cookie,
        Origin: new URL(fixture.environment.betterAuthUrl).origin,
        "Content-Type": "application/json",
      },
      body: "{}",
    }),
  );
  expect(signedOut.status).toBe(200);
  expect(
    await fixture.db.select().from(sessions).where(eq(sessions.id, sessionId)),
  ).toHaveLength(0);
  const [grant] = await fixture.db.select().from(grantContexts);
  expect(grant!.authenticationSessionId).toBe(sessionId);
  expect(grant!.revokedAt).toBeNull();
  for (const refresh_token of [issued.refresh_token, next.refresh_token])
    expect(
      (await redeem({ grant_type: "refresh_token", refresh_token, resource }))
        .status,
    ).toBe(200);
  const result = await inPlatformUsers(fixture.db, (context) =>
    revokeUserSessions(context, fixture.principals.tenantAdmin.userId),
  );
  expect(result).toMatchObject({ revoked: 0, changed: true });
  const calls = claimsCalls;
  for (const refresh_token of [issued.refresh_token, next.refresh_token])
    expect(
      (await redeem({ grant_type: "refresh_token", refresh_token, resource }))
        .status,
    ).toBe(400);
  expect(claimsCalls).toBe(calls);
});

const ssoPolicyInput = {
  issuer: "https://sso.example.com",
  domain: "sso.example.com",
  oidc: { clientId: "sso", clientSecret: "original-secret" },
};

for (const mode of ["create", "update", "delete"] as const) {
  test(`SSO ${mode} denies tenant A cached and rotated refresh while preserving tenant B`, async () => {
    const provider = await currentSsoPolicyInput();
    if (mode !== "create")
      await inPlatformWrite(fixture.db, (context) =>
        putSsoProvider(context, fixture.tenant.organizationId, provider),
      );
    const a = await (await initial()).json();
    const rotatedResponse = await redeem({
      grant_type: "refresh_token",
      refresh_token: a.refresh_token,
      resource,
    });
    expect(rotatedResponse.status).toBe(200);
    const rotated = await rotatedResponse.json();
    const [otherMember] = await fixture.db
      .select()
      .from(members)
      .where(
        and(
          eq(members.userId, fixture.principals.tenantAdmin.userId),
          eq(members.organizationId, fixture.outsider.organizationId),
        ),
      );
    selectedMemberId = otherMember!.id;
    let b: { refresh_token: string };
    try {
      b = await (await initial()).json();
    } finally {
      selectedMemberId = undefined;
    }
    await inPlatformWrite(fixture.db, async (context) => {
      if (mode === "delete")
        await deleteSsoProvider(context, fixture.tenant.organizationId);
      else
        await putSsoProvider(context, fixture.tenant.organizationId, {
          ...provider,
          oidc: { ...provider.oidc, clientSecret: "replacement-secret" },
        });
    });
    // Restoring provider configuration must not revive the old authorisation.
    await inPlatformWrite(fixture.db, (context) =>
      putSsoProvider(context, fixture.tenant.organizationId, provider),
    );
    const before = claimsCalls;
    for (const refresh_token of [a.refresh_token, rotated.refresh_token]) {
      const denied = await redeem({
        grant_type: "refresh_token",
        refresh_token,
        resource,
      });
      expect(denied.status).toBe(400);
      expect(await denied.json()).toMatchObject({ error: "invalid_grant" });
    }
    expect(claimsCalls).toBe(before);
    expect(
      (
        await redeem({
          grant_type: "refresh_token",
          refresh_token: b!.refresh_token,
          resource,
        })
      ).status,
    ).toBe(200);
    expect(
      await fixture.db
        .select()
        .from(sessions)
        .where(eq(sessions.id, sessionId)),
    ).toHaveLength(1);
  });
}

test("grant contexts are hidden from an unscoped restricted broker connection", async () => {
  const code = await authorize();
  expect(
    (
      await redeem({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: redirect,
        resource,
      })
    ).status,
  ).toBe(200);
  expect(await fixture.db.select().from(grantContexts)).toHaveLength(1);
  expect(await runtime.db.select().from(grantContexts)).toEqual([]);
});

test("grant RLS scopes isolate tenants, clients and admission sessions and restore pooled settings", async () => {
  await authorize();
  const [a] = await fixture.db.select().from(grantContexts);
  const [membership] = await fixture.db
    .select()
    .from(members)
    .where(
      and(
        eq(members.organizationId, fixture.outsider.organizationId),
        eq(members.userId, a!.userId),
      ),
    );
  const b = await createResourceGrant(
    runtime.db,
    {
      userId: a!.userId,
      sessionId: (await authenticateB()).sessionId,
      memberId: membership!.id,
      clientId,
      resource,
      scopes: ["proof:read"],
    },
    3600,
  );
  const ids = (rows: { id: string }[]) => rows.map((row) => row.id).sort();
  const read = (tx: Executor) =>
    tx.select({ id: grantContexts.id }).from(grantContexts);
  const both = [a!.id, b.id].sort();
  expect(await read(runtime.db)).toEqual([]);
  for (const [organizationId, expected] of [
    [a!.organizationId, a!.id],
    [b.organizationId, b.id],
  ]) {
    expect(
      ids(
        await withDatabaseScope(
          runtime.db,
          { kind: "tenant", access: "read", organizationId: organizationId! },
          read,
        ),
      ),
    ).toEqual([expected!]);
  }
  expect(
    ids(
      await withDatabaseScope(
        runtime.db,
        { kind: "grant-client", clientId },
        read,
      ),
    ),
  ).toEqual(both);
  expect(
    await withDatabaseScope(
      runtime.db,
      { kind: "grant-client", clientId: "another-client" },
      read,
    ),
  ).toEqual([]);
  expect(
    ids(
      await withDatabaseScope(
        runtime.db,
        { kind: "policy-user", userId: a!.userId },
        read,
      ),
    ),
  ).toEqual(both);
  expect(
    await withDatabaseScope(
      runtime.db,
      { kind: "policy-user", userId: createId() },
      read,
    ),
  ).toEqual([]);
  expect(
    await withDatabaseScope(
      runtime.db,
      { kind: "grant-admission", userId: a!.userId, sessionId: createId() },
      read,
    ),
  ).toEqual([]);
  const revoke = (tx: Executor) =>
    tx
      .update(grantContexts)
      .set({ revokedAt: new Date() })
      .returning({ id: grantContexts.id });
  expect(await revoke(runtime.db)).toEqual([]);
  expect(
    await withDatabaseScope(
      runtime.db,
      { kind: "grant-client", clientId: "another-client" },
      revoke,
    ),
  ).toEqual([]);
  expect(
    await withDatabaseScope(
      runtime.db,
      { kind: "policy-user", userId: a!.userId },
      revoke,
    ),
  ).toEqual([]);
  await expect(
    withDatabaseScope(
      runtime.db,
      { kind: "grant-admission", userId: a!.userId, sessionId: createId() },
      (tx) =>
        tx
          .insert(grantContexts)
          .values({ ...a!, id: createId() })
          .execute(),
    ),
  ).rejects.toMatchObject({ cause: { code: "42501" } });

  expect(
    await withDatabaseScope(
      runtime.db,
      { kind: "tenant", access: "read", organizationId: a!.organizationId },
      revoke,
    ),
  ).toEqual([]);
  expect(
    await withDatabaseScope(
      runtime.db,
      { kind: "grant-admission", userId: a!.userId, sessionId },
      revoke,
    ),
  ).toEqual([]);
  expect(
    await withDatabaseScope(
      runtime.db,
      { kind: "grant-client", clientId },
      (tx) => tx.delete(grantContexts).returning(),
    ),
  ).toEqual([]);
  await expect(
    runtime.db
      .insert(grantContexts)
      .values({ ...a!, id: createId() })
      .execute(),
  ).rejects.toMatchObject({ cause: { code: "42501" } });
  await expect(
    withDatabaseScope(
      runtime.db,
      { kind: "tenant", access: "write", organizationId: a!.organizationId },
      async (tx) => {
        expect(ids(await revoke(tx))).toEqual([a!.id]);
        await withDatabaseScope(
          tx,
          { kind: "grant-client", clientId },
          async (nested) => {
            expect(ids(await read(nested))).toEqual(both);
          },
        );
        expect(ids(await read(tx))).toEqual([a!.id]);
        throw new Error("rollback scoped revocation");
      },
    ),
  ).rejects.toThrow("rollback scoped revocation");
  expect(
    (await fixture.db.select().from(grantContexts)).every(
      (row) => row.revokedAt === null,
    ),
  ).toBe(true);
  expect(await read(runtime.db)).toEqual([]);
  const settings = await runtime.db.execute(
    sql`select nullif(current_setting('answerable.scope', true), '') as scope, nullif(current_setting('answerable.client', true), '') as client, nullif(current_setting('answerable.session', true), '') as session, nullif(current_setting('answerable.subject', true), '') as subject, nullif(current_setting('answerable.tenant', true), '') as tenant`,
  );
  expect(settings.rows).toEqual([
    { scope: null, client: null, session: null, subject: null, tenant: null },
  ]);
});
