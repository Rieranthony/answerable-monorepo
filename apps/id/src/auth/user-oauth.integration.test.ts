import { createIdVerifier } from "@answerable/auth";
import {
  makeSignature,
  symmetricDecrypt,
  symmetricEncrypt,
} from "better-auth/crypto";
import type { jwt } from "better-auth/plugins/jwt";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  and,
  eq,
  like,
  sql,
  TransactionRollbackError,
  type SQL,
} from "drizzle-orm";
import {
  createLocalJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  exportJWK,
  generateKeyPair,
  jwtVerify,
  SignJWT,
} from "jose";
import { createHash } from "node:crypto";
import { createAdminFixture, type AdminFixture } from "../__tests__/admin.ts";
import { signInThroughIdp } from "../__tests__/federation.ts";
import {
  softDeleteClient,
  softDeleteUser,
} from "../__tests__/soft-deletion.ts";
import {
  inPlatformUsers,
  inPlatformWrite,
} from "../__tests__/platform-context.ts";
import { inTenant, inTenantRead } from "../__tests__/tenant-command.ts";
import { createApp } from "../app.ts";
import { createAuth } from "../auth.ts";
import { createDatabase, type Database, type Executor } from "../db/client.ts";
import { withDatabaseScope } from "../db/isolation.ts";
import { memberAccess } from "../db/queries/access.ts";
import { configureRuntimeRole } from "../db/runtime-role.ts";
import {
  accounts,
  auditEvents,
  auditEventUsers,
  entitlements,
  grantContexts,
  groupMembers,
  groups,
  jwks as jwksTable,
  members,
  oauthAccessTokens,
  oauthClientAssertions,
  oauthClientResources,
  oauthClients,
  oauthConsents,
  organizationCapabilities,
  oauthRefreshTokens,
  oauthResources,
  organizations,
  sessions,
  ssoProviders,
  users,
  verifications,
} from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";
import {
  createCapability,
  updateCapability,
} from "../services/capabilities.ts";
import { hashClientSecret } from "../services/client-secrets.ts";
import {
  disableClient,
  enableClient,
  rotateSecret,
  unlinkResource,
  updateClient,
} from "../services/clients.ts";
import {
  reinstate as reinstateMember,
  remove as removeMember,
} from "../services/members.ts";
import {
  disableOrganization,
  enableOrganization,
} from "../services/organizations.ts";
import {
  disableResource,
  enableResource,
  updateResource,
} from "../services/resources.ts";
import { revokeUserSession, revokeUserSessions } from "../services/sessions.ts";
import {
  deleteSsoProvider,
  putSsoProvider,
} from "../services/sso-providers.ts";
import { disableUser, enableUser } from "../services/users.ts";
import { currentGrantAuthentication } from "./grant-authentication.ts";
import { createResourceGrant } from "./create-resource-grant.ts";
import { bindGrantCode } from "./native-code-replay.ts";
import { userResourcePolicy } from "./user-resource-policy.ts";

let fixture: AdminFixture;
let runtime: ReturnType<typeof createDatabase>;
let auth: ReturnType<typeof createAuth>;
let role: string;
let browserCookie: string;
const clientId = "omnichat";
const resource = "https://m365.example/mcp";
const redirect = "https://client.example/callback";
const verifier = "v".repeat(64);
const secret = "production-oauth-test-client-secret";

beforeEach(async () => {
  fixture = undefined!;
  runtime = undefined!;
  role = "";
  fixture = await createAdminFixture();
  browserCookie = fixture.principals.tenantAdmin.cookie;
  await fixture.db.insert(oauthClients).values({
    id: createId(),
    clientId,
    clientSecret: hashClientSecret(secret),
    name: "OmniChat",
    uri: "https://client.example",
    organizationId: fixture.tenant.organizationId,
    scopes: ["openid", "email", "offline_access", "mail:read"],
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    redirectUris: [redirect],
    tokenEndpointAuthMethod: "client_secret_basic",
    requirePKCE: true,
    skipConsent: false,
  });
  await fixture.db.insert(oauthResources).values({
    id: createId(),
    identifier: resource,
    name: "Microsoft 365",
    allowedScopes: ["openid", "email", "offline_access", "mail:read"],
    accessTokenTtl: 300,
  });
  await fixture.db
    .insert(oauthClientResources)
    .values({ id: createId(), clientId, resourceId: resource });
  await inPlatformWrite(fixture.db, async (context) => {
    for (const input of [
      {
        clientId,
        resource: null,
        grantKind: "authorization_code" as const,
        scopes: ["openid", "email", "offline_access"],
      },
      {
        clientId,
        resource,
        grantKind: "authorization_code" as const,
        scopes: ["mail:read"],
      },
      {
        clientId,
        resource,
        grantKind: "refresh_token" as const,
        scopes: ["mail:read"],
      },
    ])
      await createCapability(context, fixture.tenant.organizationId, input);
  });
  await fixture.db.insert(entitlements).values([
    {
      id: createId(),
      organizationId: fixture.tenant.organizationId,
      clientId,
      scopes: ["openid", "email", "offline_access"],
    },
    {
      id: createId(),
      organizationId: fixture.tenant.organizationId,
      clientId,
      resource,
      scopes: ["mail:read"],
    },
  ]);
  role = `id_test_oauth_${crypto.randomUUID().replaceAll("-", "")}`;
  await configureRuntimeRole(fixture.db, role);
  const password = crypto.randomUUID().replaceAll("-", "");
  await fixture.db.execute(
    sql.raw(`alter role "${role}" login password '${password}'`),
  );
  const url = new URL(fixture.environment.databaseUrl);
  url.username = role;
  url.password = password;
  runtime = createDatabase({
    ...fixture.environment,
    databaseUrl: url.toString(),
    databasePoolMax: 4,
  });
  const provider = createAuth(runtime.db, fixture.environment);
  const app = createApp({
    auth: provider,
    db: runtime.db,
    environment: fixture.environment,
  });
  auth = { ...provider, handler: async (request) => app.fetch(request) };
});

afterEach(async () => {
  await runtime?.close();
  if (fixture && role) {
    await fixture.db.execute(sql`drop owned by ${sql.identifier(role)}`);
    await fixture.db.execute(sql`drop role ${sql.identifier(role)}`);
  }
  await fixture?.close();
});

function request(
  path: string,
  body?: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return auth.handler(
    new Request(`${fixture.environment.betterAuthUrl}/auth${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        cookie: browserCookie,
        origin: fixture.trustedOrigin,
        ...(body ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

async function start(
  scope = "openid offline_access mail:read",
  target: string | null = resource,
  acceptJson = false,
  claims?: string,
) {
  const query = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirect,
    scope,
    ...(target ? { resource: target } : {}),
    state: "client-state",
    nonce: "client-nonce",
    ...(claims ? { claims } : {}),
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  });
  const start = await request(
    `/oauth2/authorize?${query}`,
    undefined,
    acceptJson ? { accept: "application/json" } : {},
  );
  const selection = new URL(
    start.status === 200
      ? (await start.json()).url
      : start.headers.get("location")!,
  );
  expect(selection.pathname).toBe("/authorize");
  return selection;
}

async function select(
  selection: URL,
  memberId = fixture.principals.tenantAdmin.memberId,
) {
  const selected = await request("/oauth2/continue", {
    oauth_query: selection.search.slice(1),
    postLogin: true,
    memberId,
  });
  expect(selected.status).toBe(200);
  return new URL((await selected.json()).url);
}

async function authorize(scope?: string, target?: string | null) {
  const selection = await start(scope, target);
  const consent = await select(selection);
  const accepted = await request("/oauth2/consent", {
    oauth_query: consent.search.slice(1),
    accept: true,
  });
  expect(accepted.status).toBe(200);
  const callback = new URL((await accepted.json()).url);
  return callback.searchParams.get("code")!;
}

function exchange(body: Record<string, string>, path = "token") {
  return auth.handler(
    new Request(`${fixture.environment.betterAuthUrl}/auth/oauth2/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`,
      },
      body: new URLSearchParams(body),
    }),
  );
}

async function issue(scope?: string, target?: string | null) {
  const code = await authorize(scope, target);
  const response = await exchange({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirect,
    code_verifier: verifier,
    ...(target === null ? {} : { resource }),
  });
  expect(response.status).toBe(200);
  return response.json();
}

test("registered public clients still need the native PKCE proof", async () => {
  await fixture.db
    .update(oauthClients)
    .set({ tokenEndpointAuthMethod: "none", clientSecret: null })
    .where(eq(oauthClients.clientId, clientId));
  const code = await authorize();
  const redeem = (codeVerifier: string) =>
    auth.handler(
      new Request(`${fixture.environment.betterAuthUrl}/auth/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          code,
          code_verifier: codeVerifier,
          redirect_uri: redirect,
          resource,
        }),
      }),
    );
  expect((await redeem("wrong".repeat(16))).status).toBe(401);
  expect((await redeem(verifier)).status).toBe(200);
});

test("private-key authentication stays consumed when a production code exchange rolls back", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  await fixture.db
    .update(oauthClients)
    .set({
      tokenEndpointAuthMethod: "private_key_jwt",
      jwks: JSON.stringify({
        keys: [
          {
            ...(await exportJWK(publicKey)),
            kid: "oauth-production",
            alg: "RS256",
          },
        ],
      }),
    })
    .where(eq(oauthClients.clientId, clientId));
  const code = await authorize();
  const assertion = () =>
    new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "oauth-production" })
      .setIssuer(clientId)
      .setSubject(clientId)
      .setAudience(`${fixture.environment.betterAuthUrl}/auth/oauth2/token`)
      .setIssuedAt()
      .setExpirationTime("2m")
      .setJti(createId())
      .sign(privateKey);
  const redeem = (jwt: string, codeVerifier: string, grant = code) =>
    auth.handler(
      new Request(`${fixture.environment.betterAuthUrl}/auth/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          code: grant,
          code_verifier: codeVerifier,
          redirect_uri: redirect,
          resource,
          client_assertion_type:
            "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: jwt,
        }),
      }),
    );
  const proof = await assertion();
  expect((await redeem(proof, "wrong".repeat(16))).status).toBe(401);
  expect((await redeem(proof, verifier)).status).toBeGreaterThanOrEqual(400);
  expect(
    await fixture.db.$count(
      auditEvents,
      eq(auditEvents.action, "oauth.user.issued"),
    ),
  ).toBe(0);
  const shared = await assertion();
  const concurrent = await Promise.all([
    redeem(shared, verifier),
    redeem(shared, verifier),
  ]);
  expect(concurrent.map((response) => response.status).sort()).toEqual([
    200, 400,
  ]);
  expect(await fixture.db.$count(oauthClientAssertions)).toBe(2);
  await fixture.db
    .update(oauthClients)
    .set({ jwks: JSON.stringify({ keys: [] }) })
    .where(eq(oauthClients.clientId, clientId));
  const removedKey = await redeem(
    await assertion(),
    verifier,
    await authorize(),
  );
  expect(removedKey.status).toBe(401);
  expect(await removedKey.json()).toMatchObject({ error: "invalid_client" });
});

test("refresh survives browser sign-out and can narrow resource scopes without changing tenant", async () => {
  const issued = await issue();
  expect((await request("/sign-out", {})).status).toBe(200);
  browserCookie = "";
  const narrowed = await exchange({
    grant_type: "refresh_token",
    refresh_token: issued.refresh_token,
    resource,
    scope: "mail:read",
  });
  expect(narrowed.status).toBe(200);
  const next = await narrowed.json();
  expect(next.scope).toBe("mail:read");
  expect(decodeJwt(next.access_token).organization_id).toBe(
    fixture.tenant.organizationId,
  );
  expect(next.id_token).toBeUndefined();
  expect(typeof next.refresh_token).toBe("string");
  expect(
    (
      await exchange({
        grant_type: "refresh_token",
        refresh_token: next.refresh_token,
        resource,
        scope: "email mail:read",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await exchange({
        grant_type: "refresh_token",
        refresh_token: next.refresh_token,
        resource: "https://wrong.example/mcp",
      })
    ).status,
  ).toBe(400);
  const final = await refresh(next.refresh_token);
  expect(final.status).toBe(200);
  expect((await final.json()).refresh_token).toBeUndefined();
});

test("unknown revocation and opaque access revocation do not revoke another grant", async () => {
  const issued = await issue("openid email offline_access", null);
  expect((await exchange({ token: "unknown-token" }, "revoke")).status).toBe(
    200,
  );
  const revoked = await exchange(
    { token: issued.access_token, token_type_hint: "access_token" },
    "revoke",
  );
  expect(revoked.status).toBe(200);
  expect(revoked.headers.get("cache-control")).toBe("no-store");
  const info = await auth.handler(
    new Request(`${fixture.environment.betterAuthUrl}/auth/oauth2/userinfo`, {
      headers: { authorization: `Bearer ${issued.access_token}` },
    }),
  );
  expect(info.status).toBe(401);
  expect(
    (await fixture.db.select().from(grantContexts))[0]!.revokedAt,
  ).toBeNull();
});

test("each new flow needs consent unless the registered client explicitly skips it", async () => {
  await issue();
  const next = await select(await start());
  expect(next.pathname).toBe("/consent");
  await fixture.db
    .update(oauthClients)
    .set({ skipConsent: true })
    .where(eq(oauthClients.clientId, clientId));
  const callback = await select(await start());
  expect(callback.searchParams.get("code")).toBeString();
  expect(
    (
      await exchange({
        grant_type: "authorization_code",
        code: callback.searchParams.get("code")!,
        redirect_uri: redirect,
        code_verifier: verifier,
        resource,
      })
    ).status,
  ).toBe(200);
});

test("expired, unselected and caller-supplied flows cannot authorise", async () => {
  const selection = await start();
  expect(
    (
      await request("/oauth2/consent", {
        oauth_query: selection.search.slice(1),
        accept: true,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await request("/oauth2/continue", {
        oauth_query: selection.search.slice(1),
        memberId: fixture.principals.tenantAdmin.memberId,
        postLogin: false,
      })
    ).status,
  ).toBe(400);
  await fixture.db
    .update(verifications)
    .set({ expiresAt: new Date(0) })
    .where(
      eq(verifications.id, selection.searchParams.get("answerable_flow")!),
    );
  expect(
    (await request("/oauth2/flow", { oauth_query: selection.search.slice(1) }))
      .status,
  ).toBe(400);
  expect(
    (await request(`/oauth2/authorize?${selection.searchParams}`)).status,
  ).toBe(400);
  expect(await fixture.db.$count(grantContexts)).toBe(0);
});

test("refresh audit failure rolls back rotation and leaves the original token usable", async () => {
  const issued = await issue();
  await fixture.db.execute(
    sql`create function reject_refresh_audit() returns trigger language plpgsql as $$ begin if NEW.action = 'oauth.user.issued' then raise exception 'test audit storage failure'; end if; return NEW; end $$`,
  );
  await fixture.db.execute(
    sql`create trigger reject_refresh_audit before insert on audit_events for each row execute function reject_refresh_audit()`,
  );
  const input = {
    grant_type: "refresh_token",
    refresh_token: issued.refresh_token,
    resource,
  };
  try {
    expect((await exchange(input)).status).toBe(503);
    expect(await fixture.db.$count(oauthRefreshTokens)).toBe(1);
  } finally {
    await fixture.db.execute(
      sql`drop trigger reject_refresh_audit on audit_events`,
    );
    await fixture.db.execute(sql`drop function reject_refresh_audit()`);
  }
  expect((await exchange(input)).status).toBe(200);
});

test("divergent native access and ID tokens preserve the code", async () => {
  const code = await authorize();
  const signer = auth.options.plugins.find(
    (plugin) => plugin.id === "jwt",
  ) as ReturnType<typeof jwt>;
  const { privateKey } = await generateKeyPair("EdDSA");
  signer.options.jwks = {
    ...signer.options.jwks,
    keyPairConfig: { alg: "EdDSA" },
  };
  const input = {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirect,
    code_verifier: verifier,
    resource,
  };
  for (const fault of ["access-scope", "id-nonce"] as const) {
    signer.options.jwt!.sign = async (payload, header) => {
      const changed = { ...payload };
      const isId = payload.nonce !== undefined;
      if (!isId && fault === "access-scope") changed.scope = "email";
      if (isId && fault === "id-nonce") changed.nonce = "wrong-nonce";
      return new SignJWT(changed)
        .setProtectedHeader({ alg: "EdDSA", ...header })
        .sign(privateKey);
    };
    expect((await exchange(input)).status, fault).toBe(400);
    expect(await fixture.db.$count(oauthRefreshTokens), fault).toBe(0);
    expect(
      await fixture.db.$count(
        auditEvents,
        eq(auditEvents.action, "oauth.user.issued"),
      ),
      fault,
    ).toBe(0);
  }
  signer.options.jwt!.sign = undefined;
  expect((await exchange(input)).status).toBe(200);
});

test("opaque and refresh rows must match the returned grant and authentication", async () => {
  const code = await authorize("openid email offline_access", null);
  const input = {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirect,
    code_verifier: verifier,
  };
  for (const [table, assignment] of [
    ["oauth_access_tokens", "NEW.scopes := ARRAY['openid']"],
    ["oauth_refresh_tokens", "NEW.reference_id := 'wrong-grant'"],
    [
      "oauth_refresh_tokens",
      "NEW.auth_time := NEW.auth_time - interval '1 second'",
    ],
  ]) {
    await fixture.db.execute(
      sql.raw(
        `create function corrupt_stored_output() returns trigger language plpgsql as $$ begin ${assignment}; return NEW; end $$`,
      ),
    );
    await fixture.db.execute(
      sql.raw(
        `create trigger corrupt_stored_output before insert on ${table} for each row execute function corrupt_stored_output()`,
      ),
    );
    try {
      expect((await exchange(input)).status, assignment).toBe(400);
      expect(await fixture.db.$count(oauthAccessTokens)).toBe(0);
      expect(await fixture.db.$count(oauthRefreshTokens)).toBe(0);
      expect(
        await fixture.db.$count(
          auditEvents,
          eq(auditEvents.action, "oauth.user.issued"),
        ),
      ).toBe(0);
    } finally {
      await fixture.db.execute(
        sql.raw(`drop trigger corrupt_stored_output on ${table}`),
      );
      await fixture.db.execute(sql`drop function corrupt_stored_output()`);
    }
  }
  expect((await exchange(input)).status).toBe(200);
});

test("consent narrowing is authorised and audited before native resource filtering", async () => {
  const consent = await select(await start());
  const input = { oauth_query: consent.search.slice(1), accept: true };
  expect(
    (await request("/oauth2/consent", { ...input, scope: "email mail:read" }))
      .status,
  ).toBe(400);
  expect(await fixture.db.$count(oauthConsents)).toBe(0);
  const accepted = await request("/oauth2/consent", {
    ...input,
    scope: "mail:read",
  });
  expect(accepted.status).toBe(200);
  const code = new URL((await accepted.json()).url).searchParams.get("code")!;
  const [event] = await fixture.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.action, "oauth.user.authorized"));
  expect(event!.data).toMatchObject({
    scopes: ["mail:read"],
    decision: { requestedScopes: ["mail:read"], scopes: ["mail:read"] },
  });
  const issued = await exchange({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirect,
    code_verifier: verifier,
    resource,
  });
  expect(issued.status).toBe(200);
  expect(await issued.json()).toMatchObject({ scope: "mail:read" });
  const [outcome] = await fixture.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.action, "oauth.user.issued"));
  expect(outcome!.data).toMatchObject({
    scopes: ["mail:read"],
    decision: { requestedScopes: ["mail:read"] },
  });
});

test("cached output and returned refresh rows are checked again without a success audit on divergence", async () => {
  const provider = createAuth(runtime.db, {
    ...fixture.environment,
    oauthRefreshReuseIntervalSeconds: 60,
  });
  const app = createApp({
    auth: provider,
    db: runtime.db,
    environment: fixture.environment,
  });
  auth = { ...provider, handler: async (request) => app.fetch(request) };
  const issued = await issue();
  const input = {
    grant_type: "refresh_token",
    refresh_token: issued.refresh_token,
    resource,
    scope: "mail:read",
  };
  const first = await exchange(input);
  expect(first.status).toBe(200);
  const saved = await first.json();
  const [original] = await fixture.db
    .select()
    .from(oauthRefreshTokens)
    .where(sql`${oauthRefreshTokens.rotatedAt} is not null`);
  const [replacement] = await fixture.db
    .select()
    .from(oauthRefreshTokens)
    .where(sql`${oauthRefreshTokens.rotatedAt} is null`);
  const key = fixture.environment.betterAuthSecret;
  const replay = JSON.parse(
    await symmetricDecrypt({ key, data: original!.rotationReplayResponse! }),
  );
  for (const fault of [
    "unexpected-id",
    "unknown-refresh",
    "token-type",
    "stored-scope",
  ] as const) {
    const changed = structuredClone(replay);
    if (fault === "unexpected-id") changed.response.id_token = issued.id_token;
    if (fault === "unknown-refresh")
      changed.response.refresh_token = "not-a-stored-token";
    if (fault === "token-type") changed.response.token_type = "DPoP";
    if (fault === "stored-scope")
      await fixture.db
        .update(oauthRefreshTokens)
        .set({ scopes: ["email"] })
        .where(eq(oauthRefreshTokens.id, replacement!.id));
    await fixture.db
      .update(oauthRefreshTokens)
      .set({
        rotationReplayResponse: await symmetricEncrypt({
          key,
          data: JSON.stringify(changed),
        }),
      })
      .where(eq(oauthRefreshTokens.id, original!.id));
    expect((await exchange(input)).status, fault).toBe(400);
    expect(await fixture.db.$count(oauthRefreshTokens)).toBe(2);
    expect(
      await fixture.db.$count(
        auditEvents,
        eq(auditEvents.action, "oauth.user.replayed"),
      ),
    ).toBe(0);
    await fixture.db
      .update(oauthRefreshTokens)
      .set({ scopes: replacement!.scopes })
      .where(eq(oauthRefreshTokens.id, replacement!.id));
  }
  await fixture.db
    .update(oauthRefreshTokens)
    .set({ rotationReplayResponse: original!.rotationReplayResponse })
    .where(eq(oauthRefreshTokens.id, original!.id));
  const valid = await exchange(input);
  expect(valid.status).toBe(200);
  expect(await valid.json()).toMatchObject({
    access_token: saved.access_token,
    refresh_token: saved.refresh_token,
    scope: "mail:read",
  });
  expect(
    await fixture.db.$count(
      auditEvents,
      eq(auditEvents.action, "oauth.user.replayed"),
    ),
  ).toBe(1);
});

test("inconsistent or revoked authentication evidence cannot establish current authority", async () => {
  await issue();
  const [grant] = await fixture.db.select().from(grantContexts);
  expect(await currentGrantAuthentication(fixture.db, grant!)).toBe(true);
  for (const patch of [
    { authenticationAccountId: createId() },
    { authenticationProviderId: createId() },
    {
      authenticationProviderRevision: grant!.authenticationProviderRevision + 1,
    },
    { memberId: createId() },
    { revokedAt: new Date() },
  ])
    expect(
      await currentGrantAuthentication(fixture.db, { ...grant!, ...patch }),
    ).toBe(false);
});

test("JSON authorisation starts and consent details retain the selected membership", async () => {
  const consent = await select(await start(undefined, undefined, true));
  const details = await request("/oauth2/flow", {
    oauth_query: consent.search.slice(1),
  });
  expect(details.status).toBe(200);
  expect(await details.json()).toMatchObject({
    status: "consent",
    selectedMemberId: fixture.principals.tenantAdmin.memberId,
  });
  expect(details.headers.get("cache-control")).toBe("no-store");
});

test("missing upstream authentication time stays unknown in tokens and retained evidence", async () => {
  fixture.issuer.enqueue({
    sub: "tenantAdmin-subject",
    email: "tenantadmin@tenant.example.com",
    email_verified: true,
  });
  await finishSso(
    await request("/sign-in/sso", {
      providerId: fixture.tenant.slug,
      callbackURL: `${fixture.trustedOrigin}/callback`,
    }),
  );
  const issued = await issue();
  expect(decodeJwt(issued.id_token).upstream_auth_time).toBeNull();
  expect(decodeJwt(issued.id_token).auth_time).toBeNumber();
  expect(
    (await fixture.db.select().from(grantContexts))[0]!.upstreamAuthTime,
  ).toBeNull();
});

test("production provider binds native tenant selection, consent and code to one grant", async () => {
  const selection = await start();
  const details = await request("/oauth2/flow", {
    oauth_query: selection.search.slice(1),
  });
  expect(details.status).toBe(200);
  const flow = await details.json();
  expect(flow.client).toMatchObject({
    clientId,
    name: "OmniChat",
    uri: "https://client.example",
  });
  const selected = await request("/oauth2/continue", {
    oauth_query: selection.search.slice(1),
    postLogin: true,
    memberId: fixture.principals.tenantAdmin.memberId,
  });
  expect(selected.status).toBe(200);
  const consent = new URL((await selected.json()).url);
  expect(consent.pathname).toBe("/consent");
  const accepted = await request("/oauth2/consent", {
    oauth_query: consent.search.slice(1),
    accept: true,
  });
  expect(accepted.status).toBe(200);
  const callback = new URL((await accepted.json()).url);
  expect(callback.origin + callback.pathname).toBe(redirect);
  expect(callback.searchParams.get("state")).toBe("client-state");
  expect(callback.searchParams.get("code")).toBeString();
  const tokens = await exchange({
    grant_type: "authorization_code",
    code: callback.searchParams.get("code")!,
    redirect_uri: redirect,
    code_verifier: verifier,
    resource,
  });
  expect(tokens.status).toBe(200);
  const issued = await tokens.json();
  expect(decodeJwt(issued.access_token)).toMatchObject({
    sub: fixture.principals.tenantAdmin.userId,
    membership_id: fixture.principals.tenantAdmin.memberId,
    organization_id: fixture.tenant.organizationId,
    subject_type: "user",
  });
  expect(decodeJwt(issued.id_token)).toMatchObject({
    sub: fixture.principals.tenantAdmin.userId,
    aud: clientId,
    nonce: "client-nonce",
  });
  const [grant] = await fixture.db
    .select()
    .from(grantContexts)
    .where(
      eq(grantContexts.id, String(decodeJwt(issued.access_token).grant_id)),
    );
  const [session] = await fixture.db
    .select()
    .from(sessions)
    .where(eq(sessions.id, grant!.authenticationSessionId));
  expect(grant).toMatchObject({
    userId: fixture.principals.tenantAdmin.userId,
    memberId: fixture.principals.tenantAdmin.memberId,
    organizationId: fixture.tenant.organizationId,
    authTime: session!.createdAt,
    authenticationAccountId: session!.authenticationAccountId,
    authenticationProviderId: session!.authenticationProviderId,
    authenticationProviderRevision: session!.authenticationProviderRevision,
    upstreamAuthTime: session!.upstreamAuthTime,
  });
  expect(decodeJwt(issued.id_token).auth_time).toBe(
    Math.floor(grant!.authTime.getTime() / 1000),
  );
  expect(decodeJwt(issued.id_token).upstream_auth_time).toBe(
    Math.floor(grant!.upstreamAuthTime!.getTime() / 1000),
  );
  const refreshed = await refresh(issued.refresh_token);
  expect(refreshed.status).toBe(200);
  const renewed = await refreshed.json();
  expect(renewed.refresh_token).not.toBe(issued.refresh_token);
  expect(decodeJwt(renewed.access_token).grant_id).toBe(
    decodeJwt(issued.access_token).grant_id,
  );
  const events = await fixture.db
    .select()
    .from(auditEvents)
    .where(like(auditEvents.action, "oauth.user.%"));
  expect(events.map((event) => event.action).sort()).toEqual([
    "oauth.user.authorized",
    "oauth.user.issued",
    "oauth.user.issued",
  ]);
  for (const event of events) {
    expect(event.targetType).toBe("grant_context");
    expect(
      await fixture.db
        .select()
        .from(auditEventUsers)
        .where(eq(auditEventUsers.eventId, event.id)),
    ).toEqual([
      { userId: fixture.principals.tenantAdmin.userId, eventId: event.id },
    ]);
  }
});

test("UserInfo validates resource access and returns the same tenant subject", async () => {
  const issued = await issue();
  const info = await auth.handler(
    new Request(`${fixture.environment.betterAuthUrl}/auth/oauth2/userinfo`, {
      headers: { authorization: `Bearer ${issued.access_token}` },
    }),
  );
  expect(info.status).toBe(200);
  expect(await info.json()).toMatchObject({
    sub: fixture.principals.tenantAdmin.userId,
    membership_id: fixture.principals.tenantAdmin.memberId,
  });
});

test("login-only OAuth issues opaque access and needs a separate renewal capability", async () => {
  const issued = await issue("openid email offline_access", null);
  expect(issued.access_token.split(".")).toHaveLength(1);
  const info = await auth.handler(
    new Request(`${fixture.environment.betterAuthUrl}/auth/oauth2/userinfo`, {
      headers: { authorization: `Bearer ${issued.access_token}` },
    }),
  );
  expect(info.status).toBe(200);
  expect(await info.json()).toMatchObject({
    sub: fixture.principals.tenantAdmin.userId,
    membership_id: fixture.principals.tenantAdmin.memberId,
  });
  expect(
    (
      await exchange({
        grant_type: "refresh_token",
        refresh_token: issued.refresh_token,
      })
    ).status,
  ).toBe(400);
  await inPlatformWrite(fixture.db, (context) =>
    createCapability(context, fixture.tenant.organizationId, {
      clientId,
      resource: null,
      grantKind: "refresh_token",
      scopes: ["openid", "email", "offline_access"],
    }),
  );
  expect(
    (
      await exchange({
        grant_type: "refresh_token",
        refresh_token: issued.refresh_token,
      })
    ).status,
  ).toBe(200);
});

test("replaying a code revokes its family and leaves a separate authorisation usable", async () => {
  const code = await authorize();
  const input = {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirect,
    code_verifier: verifier,
    resource,
  };
  const first = await exchange(input);
  expect(first.status).toBe(200);
  const issued = await first.json();
  const other = await issue();
  expect((await exchange(input)).status).toBe(400);
  expect((await refresh(issued.refresh_token)).status).toBe(400);
  expect((await refresh(other.refresh_token)).status).toBe(200);
});

test("native refresh revocation and replay remain confined to one grant", async () => {
  const first = await issue();
  const other = await issue();
  expect(
    (
      await exchange(
        { token: first.refresh_token, token_type_hint: "refresh_token" },
        "revoke",
      )
    ).status,
  ).toBe(200);
  const repeated = await exchange(
    { token: first.refresh_token, token_type_hint: "refresh_token" },
    "revoke",
  );
  expect(repeated.status).toBe(200);
  expect((await refresh(first.refresh_token)).status).toBe(400);
  expect((await refresh(other.refresh_token)).status).toBe(200);
});

test("reusing a rotated refresh token revokes only that native family and records the outcome", async () => {
  const first = await issue();
  const other = await issue();
  const input = {
    grant_type: "refresh_token",
    refresh_token: first.refresh_token,
    resource,
  };
  const rotated = await exchange(input);
  expect(rotated.status).toBe(200);
  const next = await rotated.json();
  expect((await exchange(input)).status).toBe(400);
  expect(
    (await exchange({ ...input, refresh_token: next.refresh_token })).status,
  ).toBe(400);
  expect(
    (await exchange({ ...input, refresh_token: other.refresh_token })).status,
  ).toBe(200);
  expect(
    await fixture.db.$count(
      auditEvents,
      eq(auditEvents.action, "oauth.user.revoked"),
    ),
  ).toBe(1);
});

test("signed flow forgery, wrong user, duplicate selection and duplicate consent fail closed", async () => {
  const selection = await start();
  const original = selection.search.slice(1);
  const forged = new URLSearchParams(original);
  forged.set("client_id", "attacker");
  expect(
    (await request("/oauth2/flow", { oauth_query: forged.toString() })).status,
  ).toBe(400);
  expect(
    (
      await auth.handler(
        new Request(`${fixture.environment.betterAuthUrl}/auth/oauth2/flow`, {
          method: "POST",
          headers: {
            cookie: fixture.principals.platformAdmin.cookie,
            origin: fixture.trustedOrigin,
            "content-type": "application/json",
          },
          body: JSON.stringify({ oauth_query: original }),
        }),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await request("/oauth2/continue", {
        oauth_query: original,
        postLogin: true,
        memberId: fixture.principals.platformAdmin.memberId,
      })
    ).status,
  ).toBe(403);
  const consent = await select(selection);
  expect(
    (
      await request("/oauth2/continue", {
        oauth_query: original,
        postLogin: true,
        memberId: fixture.principals.tenantAdmin.memberId,
      })
    ).status,
  ).toBe(400);
  const input = { oauth_query: consent.search.slice(1), accept: true };
  expect((await request("/oauth2/consent", input)).status).toBe(200);
  expect((await request("/oauth2/consent", input)).status).toBe(400);
  expect(await fixture.db.$count(grantContexts)).toBe(1);
});

test("native consent denial is terminal without a code", async () => {
  const consent = await select(await start());
  const denied = await request("/oauth2/consent", {
    oauth_query: consent.search.slice(1),
    accept: false,
  });
  expect(denied.status).toBe(200);
  const result = new URL((await denied.json()).url);
  expect(result.searchParams.get("error")).toBe("access_denied");
  expect(result.searchParams.get("code")).toBeNull();
  expect(
    (
      await request("/oauth2/consent", {
        oauth_query: consent.search.slice(1),
        accept: true,
      })
    ).status,
  ).toBe(400);
});

test("code issuance audit failure rolls back native code, consent and terminal flow state", async () => {
  const consent = await select(await start());
  await fixture.db.execute(
    sql`create function reject_oauth_audit() returns trigger language plpgsql as $$ begin if NEW.action like 'oauth.user.%' then raise exception 'test audit storage failure'; end if; return NEW; end $$`,
  );
  await fixture.db.execute(
    sql`create trigger reject_oauth_audit before insert on audit_events for each row execute function reject_oauth_audit()`,
  );
  const input = { oauth_query: consent.search.slice(1), accept: true };
  const failed = await request("/oauth2/consent", input);
  expect(failed.status).toBe(503);
  expect(
    await fixture.db.$count(
      verifications,
      sql`${verifications.value}::jsonb->>'type' = 'authorization_code'`,
    ),
  ).toBe(0);
  await fixture.db.execute(
    sql`drop trigger reject_oauth_audit on audit_events`,
  );
  await fixture.db.execute(sql`drop function reject_oauth_audit()`);
  expect((await request("/oauth2/consent", input)).status).toBe(200);
});

test("discovery and JWKS describe reachable endpoints and the native issuer", async () => {
  const metadata = await auth.handler(
    new Request(
      `${fixture.environment.betterAuthUrl}/.well-known/openid-configuration`,
    ),
  );
  expect(metadata.status).toBe(200);
  const document = await metadata.json();
  expect(document.issuer).toBe(fixture.environment.betterAuthUrl);
  expect(document.authorization_endpoint).toBe(
    `${fixture.environment.betterAuthUrl}/auth/oauth2/authorize`,
  );
  expect(document.grant_types_supported).toEqual([
    "authorization_code",
    "refresh_token",
    "client_credentials",
  ]);
  for (const field of [
    "introspection_endpoint",
    "registration_endpoint",
    "end_session_endpoint",
    "backchannel_logout_supported",
  ])
    expect(document[field]).toBeUndefined();
  const metadata2 = await auth.handler(
    new Request(
      `${fixture.environment.betterAuthUrl}/.well-known/oauth-authorization-server`,
    ),
  );
  expect(await metadata2.json()).toEqual(document);
  expect((await auth.handler(new Request(document.jwks_uri))).status).toBe(200);
  for (const path of [
    "/oauth2/introspect",
    "/oauth2/register",
    "/oauth2/end-session",
  ])
    expect((await request(path)).status).toBe(404);
});

test("a consumer verifies production user tokens using public discovery and JWKS", async () => {
  const issued = await issue();
  const metadata = await (
    await auth.handler(
      new Request(
        `${fixture.environment.betterAuthUrl}/.well-known/openid-configuration`,
      ),
    )
  ).json();
  expect(metadata.issuer).toBe(fixture.environment.betterAuthUrl);
  const jwks = await (
    await auth.handler(new Request(metadata.jwks_uri))
  ).json();
  for (const key of jwks.keys)
    for (const secretField of ["d", "p", "q", "dp", "dq", "qi", "k"])
      expect(key[secretField]).toBeUndefined();
  const keys = createLocalJWKSet(jwks);
  const options = {
    issuer: fixture.environment.betterAuthUrl,
    audience: resource,
    algorithms: ["EdDSA"],
    typ: "at+jwt",
    requiredClaims: ["exp", "iat", "sub"],
  };
  const { payload } = await jwtVerify(issued.access_token, keys, options);
  expect(payload).toMatchObject({
    sub: fixture.principals.tenantAdmin.userId,
    organization_id: fixture.tenant.organizationId,
    membership_id: fixture.principals.tenantAdmin.memberId,
  });
  const id = await jwtVerify(issued.id_token, keys, {
    ...options,
    audience: clientId,
    typ: undefined,
  });
  expect(id.payload.sub).toBe(payload.sub);
  expect(id.protectedHeader.typ).not.toBe("at+jwt");
  expect(id.payload.nonce).toBe("client-nonce");
  await expect(
    jwtVerify(issued.access_token, keys, {
      ...options,
      issuer: "https://foreign.example",
    }),
  ).rejects.toThrow();
  await expect(
    jwtVerify(issued.access_token, keys, {
      ...options,
      audience: "https://foreign.example/mcp",
    }),
  ).rejects.toThrow();
  await expect(jwtVerify(issued.id_token, keys, options)).rejects.toThrow();
  await expect(
    jwtVerify(issued.access_token, keys, {
      ...options,
      currentDate: new Date((Number(payload.exp) + 1) * 1000),
    }),
  ).rejects.toThrow();
  const [header, , signature] = issued.access_token.split(".");
  const forged = Buffer.from(
    JSON.stringify({
      ...payload,
      organization_id: fixture.outsider.organizationId,
    }),
  ).toString("base64url");
  await expect(
    jwtVerify(`${header}.${forged}.${signature}`, keys, options),
  ).rejects.toThrow();
  const refreshed = await refresh(issued.refresh_token);
  expect(refreshed.status).toBe(200);
  const next = await jwtVerify(
    (await refreshed.json()).access_token,
    keys,
    options,
  );
  for (const claim of ["sub", "organization_id", "membership_id", "grant_id"])
    expect(next.payload[claim]).toBe(payload[claim]);
});

test("cached native refresh responses recheck policy and record replay separately", async () => {
  const provider = createAuth(runtime.db, {
    ...fixture.environment,
    oauthRefreshReuseIntervalSeconds: 60,
  });
  const app = createApp({
    auth: provider,
    db: runtime.db,
    environment: fixture.environment,
  });
  auth = { ...provider, handler: async (request) => app.fetch(request) };
  const issued = await issue();
  const input = {
    grant_type: "refresh_token",
    refresh_token: issued.refresh_token,
    resource,
  };
  const first = await exchange(input);
  expect(first.status).toBe(200);
  const saved = await first.json();
  const replay = await exchange(input);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(saved);
  expect(
    await fixture.db.$count(
      auditEvents,
      eq(auditEvents.action, "oauth.user.replayed"),
    ),
  ).toBe(1);
  await fixture.db
    .update(entitlements)
    .set({ status: "disabled" })
    .where(
      and(
        eq(entitlements.clientId, clientId),
        eq(entitlements.resource, resource),
      ),
    );
  expect((await exchange(input)).status).toBe(400);
});

test("simultaneous consent and code submissions cannot create duplicate grants or active families", async () => {
  const consent = await select(await start());
  const responses = await Promise.all(
    [0, 1].map(() =>
      request("/oauth2/consent", {
        oauth_query: consent.search.slice(1),
        accept: true,
      }),
    ),
  );
  expect(responses.map((response) => response.status).sort()).toEqual([
    200, 400,
  ]);
  const callback = new URL(
    (await responses.find((response) => response.status === 200)!.json()).url,
  );
  const input = {
    grant_type: "authorization_code",
    code: callback.searchParams.get("code")!,
    redirect_uri: redirect,
    code_verifier: verifier,
    resource,
  };
  const exchanges = await Promise.all([exchange(input), exchange(input)]);
  expect(exchanges.map((response) => response.status).sort()).toEqual([
    200, 400,
  ]);
  expect(await fixture.db.$count(grantContexts)).toBe(1);
  const issued = await exchanges
    .find((response) => response.status === 200)!
    .json();
  expect((await refresh(issued.refresh_token)).status).toBe(400);
});

test("token audit failure preserves the code for a safe retry", async () => {
  const code = await authorize();
  await fixture.db.execute(
    sql`create function reject_token_audit() returns trigger language plpgsql as $$ begin if NEW.action = 'oauth.user.issued' then raise exception 'test audit storage failure'; end if; return NEW; end $$`,
  );
  await fixture.db.execute(
    sql`create trigger reject_token_audit before insert on audit_events for each row execute function reject_token_audit()`,
  );
  const input = {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirect,
    code_verifier: verifier,
    resource,
  };
  expect((await exchange(input)).status).toBe(503);
  expect(await fixture.db.$count(oauthRefreshTokens)).toBe(0);
  await fixture.db.execute(
    sql`drop trigger reject_token_audit on audit_events`,
  );
  await fixture.db.execute(sql`drop function reject_token_audit()`);
  expect((await exchange(input)).status).toBe(200);
});

for (const change of [
  "membership",
  "account",
  "provider",
  "session",
  "scope",
  "target",
  "pkce",
] as const)
  test(`code exchange refuses changed ${change}`, async () => {
    const code = await authorize();
    if (change === "membership")
      await fixture.db
        .update(members)
        .set({ validUntil: new Date(Date.now() - 1000) })
        .where(eq(members.id, fixture.principals.tenantAdmin.memberId));
    if (change === "account")
      await fixture.db
        .update(accounts)
        .set({
          deletedAt: new Date(),
          accessToken: null,
          refreshToken: null,
          idToken: null,
          password: null,
        })
        .where(eq(accounts.userId, fixture.principals.tenantAdmin.userId));
    if (change === "provider")
      await fixture.db
        .update(ssoProviders)
        .set({ domain: "changed.example.com" })
        .where(eq(ssoProviders.organizationId, fixture.tenant.organizationId));
    if (change === "session")
      await fixture.db
        .delete(sessions)
        .where(eq(sessions.userId, fixture.principals.tenantAdmin.userId));
    if (change === "scope")
      await fixture.db
        .update(entitlements)
        .set({ status: "disabled" })
        .where(eq(entitlements.clientId, clientId));
    const response = await exchange({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
      code_verifier: change === "pkce" ? "wrong".repeat(15) : verifier,
      resource:
        change === "target" ? "https://wrong.example/resource" : resource,
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(await fixture.db.$count(oauthRefreshTokens)).toBe(0);
  });

function responseCookie(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
}

function mergeCookies(...values: string[]) {
  const cookies = new Map<string, string>();
  for (const pair of values.join("; ").split("; ")) {
    const index = pair.indexOf("=");
    if (index > 0) cookies.set(pair.slice(0, index), pair.slice(index + 1));
  }
  return [...cookies].map(([key, value]) => `${key}=${value}`).join("; ");
}

async function finishSso(started: Response) {
  expect(started.status).toBe(200);
  const upstream = await fetch((await started.json()).url, {
    redirect: "manual",
  });
  const callback = await auth.handler(
    new Request(upstream.headers.get("location")!, {
      headers: {
        cookie: mergeCookies(browserCookie, responseCookie(started)),
        accept: "text/html",
      },
    }),
  );
  expect(callback.status).toBe(302);
  browserCookie = mergeCookies(browserCookie, responseCookie(callback));
  return callback;
}

test("native SSO resumes the signed authorisation request after login", async () => {
  const current = await start();
  const query = new URLSearchParams(current.search);
  for (const key of [
    "answerable_flow",
    "sig",
    "exp",
    "ba_iat",
    "ba_pl",
    "ba_param",
  ])
    query.delete(key);
  browserCookie = "";
  query.set("prompt", "login");
  const login = await request(`/oauth2/authorize?${query}`);
  const page = new URL(login.headers.get("location")!);
  expect(page.pathname).toBe("/login");
  fixture.issuer.enqueue({
    sub: "tenantAdmin-subject",
    email: "tenantadmin@tenant.example.com",
    email_verified: true,
    auth_time: Math.floor(Date.now() / 1000),
  });
  const callback = await finishSso(
    await request("/sign-in/sso", {
      providerId: fixture.tenant.slug,
      callbackURL: `${fixture.trustedOrigin}/callback`,
      oauth_query: page.search.slice(1),
    }),
  );
  const selection = new URL(callback.headers.get("location")!);
  expect(selection.pathname).toBe("/authorize");
  expect(selection.searchParams.get("prompt")).toBeNull();
  const details = await request("/oauth2/flow", {
    oauth_query: selection.search.slice(1),
  });
  expect(details.status).toBe(200);
  const consent = await select(selection);
  expect(consent.pathname).toBe("/consent");
  expect(
    (
      await request("/oauth2/consent", {
        oauth_query: consent.search.slice(1),
        accept: true,
      })
    ).status,
  ).toBe(200);
});

test("one global user needs independently verified target SSO for a second tenant grant", async () => {
  const userId = fixture.principals.tenantAdmin.userId;
  const memberId = createId();
  await fixture.db.insert(members).values({
    id: memberId,
    organizationId: fixture.outsider.organizationId,
    userId,
  });
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
        scopes: ["mail:read"],
      },
      {
        clientId,
        resource,
        grantKind: "refresh_token" as const,
        scopes: ["mail:read"],
      },
    ])
      await createCapability(context, fixture.outsider.organizationId, input);
  });
  await fixture.db.insert(entitlements).values([
    {
      id: createId(),
      organizationId: fixture.outsider.organizationId,
      clientId,
      scopes: ["openid", "offline_access"],
    },
    {
      id: createId(),
      organizationId: fixture.outsider.organizationId,
      clientId,
      resource,
      scopes: ["mail:read"],
    },
  ]);
  const a = await issue();
  const selection = await start();
  expect(
    (
      await request("/oauth2/continue", {
        oauth_query: selection.search.slice(1),
        postLogin: true,
        memberId,
      })
    ).status,
  ).toBe(403);
  fixture.issuer.enqueue({
    sub: "oauth-linked-target",
    email: "oauth-linked@outsider.example.com",
    email_verified: true,
    auth_time: Math.floor(Date.now() / 1000),
  });
  await finishSso(
    await request("/sso/link", {
      providerId: fixture.outsider.slug,
      callbackURL: `${fixture.trustedOrigin}/callback`,
    }),
  );
  const selectedB = await select(await start(), memberId);
  const accepted = await request("/oauth2/consent", {
    oauth_query: selectedB.search.slice(1),
    accept: true,
  });
  expect(accepted.status).toBe(200);
  const code = new URL((await accepted.json()).url).searchParams.get("code")!;
  const exchangeB = await exchange({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: redirect,
    resource,
  });
  expect(exchangeB.status).toBe(200);
  const b = await exchangeB.json();
  expect(decodeJwt(b.access_token)).toMatchObject({
    sub: userId,
    organization_id: fixture.outsider.organizationId,
    membership_id: memberId,
  });
  expect(decodeJwt(a.access_token).grant_id).not.toBe(
    decodeJwt(b.access_token).grant_id,
  );
  await fixture.db
    .update(members)
    .set({ validUntil: new Date(Date.now() - 1000) })
    .where(eq(members.id, fixture.principals.tenantAdmin.memberId));
  expect((await refresh(a.refresh_token)).status).toBe(400);
  expect((await refresh(b.refresh_token)).status).toBe(200);
});

test("the native provider rejects unsupported token grant types", async () => {
  for (const grant_type of ["password", "implicit", "unsupported"]) {
    const response = await exchange({ grant_type });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "unsupported_grant_type",
    });
  }
});

for (const invalidated of [false, true]) {
  test(`another client cannot rotate or invalidate a ${invalidated ? "revoked" : "live"} refresh family`, async () => {
    const issued = await issue();
    const otherId = "other-refresh-client";
    const [original] = await fixture.db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.clientId, clientId));
    await fixture.db
      .insert(oauthClients)
      .values({ ...original!, id: createId(), clientId: otherId });
    if (invalidated) {
      const revoked = await exchange(
        { token: issued.refresh_token, token_type_hint: "refresh_token" },
        "revoke",
      );
      expect(revoked.status).toBe(200);
    }
    const before = {
      families: await fixture.db.select().from(grantContexts),
      refresh: await fixture.db.select().from(oauthRefreshTokens),
      access: await fixture.db.select().from(oauthAccessTokens),
    };
    const response = await auth.handler(
      new Request(`${fixture.environment.betterAuthUrl}/auth/oauth2/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${Buffer.from(`${otherId}:${secret}`).toString("base64")}`,
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: issued.refresh_token,
          resource,
        }),
      }),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
    expect(await fixture.db.select().from(grantContexts)).toEqual(
      before.families,
    );
    expect(await fixture.db.select().from(oauthRefreshTokens)).toEqual(
      before.refresh,
    );
    expect(await fixture.db.select().from(oauthAccessTokens)).toEqual(
      before.access,
    );
  });
}

for (const mode of ["plain", "missing-public-challenge"] as const) {
  test(`authorize refuses PKCE ${mode} before creating a flow`, async () => {
    if (mode === "missing-public-challenge")
      await fixture.db
        .update(oauthClients)
        .set({ tokenEndpointAuthMethod: "none", clientSecret: null })
        .where(eq(oauthClients.clientId, clientId));
    const before = await fixture.db.select().from(verifications);
    const query = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: redirect,
      scope: "openid offline_access mail:read",
      resource,
      state: "pkce-security",
      ...(mode === "plain"
        ? { code_challenge_method: "plain", code_challenge: verifier }
        : {}),
    });
    const response = await request(`/oauth2/authorize?${query}`);
    const location = response.headers.get("location");
    if (location) {
      const rejected = new URL(location);
      expect(rejected.searchParams.get("error")).toBeTruthy();
      expect(rejected.searchParams.has("code")).toBe(false);
      expect(rejected.pathname).not.toBe("/authorize");
    } else {
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    }
    expect(await fixture.db.select().from(verifications)).toEqual(before);
    expect(await fixture.db.select().from(grantContexts)).toHaveLength(0);
  });
}

async function offerSendScope() {
  const scopes = [
    "openid",
    "email",
    "offline_access",
    "mail:read",
    "mail:send",
  ];
  await fixture.db
    .update(oauthClients)
    .set({ scopes })
    .where(eq(oauthClients.clientId, clientId));
  await fixture.db
    .update(oauthResources)
    .set({ allowedScopes: scopes })
    .where(eq(oauthResources.identifier, resource));
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
  await inPlatformWrite(fixture.db, (context) =>
    updateCapability(
      context,
      fixture.tenant.organizationId,
      capability!.id,
      { scopes: ["mail:read", "mail:send"] },
      capability!,
    ),
  );
}

for (const skipConsent of [false, true]) {
  test(`partial entitlement stores and issues the granted subset (skipConsent=${skipConsent})`, async () => {
    await offerSendScope();
    await fixture.db
      .update(oauthClients)
      .set({ skipConsent })
      .where(eq(oauthClients.clientId, clientId));
    const requested = ["openid", "offline_access", "mail:read", "mail:send"];
    const granted = ["mail:read", "offline_access", "openid"];
    const selection = await start(requested.join(" "));
    const initial = await request("/oauth2/flow", {
      oauth_query: selection.search.slice(1),
    });
    expect((await initial.json()).grantedScopes).toBeNull();
    let callback = await select(selection);
    if (!skipConsent) {
      expect(callback.pathname).toBe("/consent");
      const details = await request("/oauth2/flow", {
        oauth_query: callback.search.slice(1),
      });
      expect(await details.json()).toMatchObject({
        scopes: requested,
        grantedScopes: granted,
      });
      const accepted = await request("/oauth2/consent", {
        oauth_query: callback.search.slice(1),
        accept: true,
      });
      expect(accepted.status).toBe(200);
      callback = new URL((await accepted.json()).url);
      const [consent] = await fixture.db.select().from(oauthConsents);
      expect(consent!.scopes.slice().sort()).toEqual(granted);
    }
    const [stored] = await fixture.db
      .select()
      .from(verifications)
      .where(
        sql`${verifications.value}::jsonb->>'type' = 'authorization_code'`,
      );
    expect(JSON.parse(stored!.value).query.scope.split(" ").sort()).toEqual(
      granted,
    );
    const [event] = await fixture.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "oauth.user.authorized"));
    expect(event!.data).toMatchObject({
      scopes: granted,
      decision: {
        requestedScopes: requested.slice().sort(),
        grantedScopes: granted,
        scopes: ["mail:read"],
      },
    });
    const response = await exchange({
      grant_type: "authorization_code",
      code: callback.searchParams.get("code")!,
      redirect_uri: redirect,
      code_verifier: verifier,
      resource,
    });
    expect(response.status).toBe(200);
    const issued = await response.json();
    expect(issued.scope.split(" ").sort()).toEqual(granted);
    expect(
      String(decodeJwt(issued.access_token).scope).split(" ").sort(),
    ).toEqual(granted);
    expect(issued.id_token).toBeString();
    expect(issued.refresh_token).toBeString();
    const refreshed = await refresh(issued.refresh_token);
    expect(refreshed.status).toBe(200);
    const next = await refreshed.json();
    expect(next.scope.split(" ").sort()).toEqual(granted);
    const widened = await exchange({
      grant_type: "refresh_token",
      refresh_token: next.refresh_token,
      resource,
      scope: "mail:send",
    });
    expect(widened.status).toBe(400);
    expect(await widened.json()).toMatchObject({ error: "invalid_scope" });
  });
}

test("browser authorisation drops unapproved identity scopes", async () => {
  await fixture.db
    .update(entitlements)
    .set({ scopes: ["openid", "offline_access"] })
    .where(
      and(
        eq(entitlements.clientId, clientId),
        sql`${entitlements.resource} is null`,
      ),
    );
  const issued = await issue("openid email offline_access mail:read");
  expect(issued.scope.split(" ").sort()).toEqual([
    "mail:read",
    "offline_access",
    "openid",
  ]);
  expect(String(decodeJwt(issued.access_token).scope).split(" ")).not.toContain(
    "email",
  );
});

for (const refusal of ["service", "login", "claims"] as const) {
  test(`empty ${refusal} approval refuses selection without storing a grant`, async () => {
    await offerSendScope();
    await fixture.db
      .update(entitlements)
      .set({ scopes: ["offline_access"] })
      .where(
        and(
          eq(entitlements.clientId, clientId),
          sql`${entitlements.resource} is null`,
        ),
      );
    const selection = await start(
      refusal === "service"
        ? "openid offline_access mail:send"
        : refusal === "login"
          ? "openid"
          : "openid offline_access mail:read",
      refusal === "login" ? null : resource,
      false,
      refusal === "claims"
        ? JSON.stringify({ id_token: { email: null } })
        : undefined,
    );
    const response = await request("/oauth2/continue", {
      oauth_query: selection.search.slice(1),
      postLogin: true,
      memberId: fixture.principals.tenantAdmin.memberId,
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "access_denied" });
    expect(await fixture.db.$count(grantContexts)).toBe(0);
  });
}

test("denying partial consent audits the offered scopes without minting a code", async () => {
  await offerSendScope();
  const consent = await select(
    await start("openid offline_access mail:read mail:send"),
  );
  const response = await request("/oauth2/consent", {
    oauth_query: consent.search.slice(1),
    accept: false,
  });
  expect(response.status).toBe(200);
  expect(new URL((await response.json()).url).searchParams.get("error")).toBe(
    "access_denied",
  );
  const [event] = await fixture.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.action, "oauth.user.denied"));
  expect(event!.schemaVersion).toBe(1);
  expect(event!.data).toMatchObject({
    scopes: ["mail:read", "offline_access", "openid"],
    decision: { grantedScopes: ["mail:read", "offline_access", "openid"] },
  });
  expect(await fixture.db.$count(oauthConsents)).toBe(0);
  expect(
    await fixture.db.$count(
      verifications,
      sql`${verifications.value}::jsonb->>'type' = 'authorization_code'`,
    ),
  ).toBe(0);
});

async function linkSecondResource() {
  const second = "https://calendar.example/mcp";
  await fixture.db.insert(oauthResources).values({
    id: createId(),
    identifier: second,
    name: "Calendar",
    allowedScopes: ["mail:read"],
    accessTokenTtl: 300,
  });
  await fixture.db
    .insert(oauthClientResources)
    .values({ id: createId(), clientId, resourceId: second });
  await inPlatformWrite(fixture.db, async (context) => {
    for (const grantKind of ["authorization_code", "refresh_token"] as const)
      await createCapability(context, fixture.tenant.organizationId, {
        clientId,
        resource: second,
        grantKind,
        scopes: ["mail:read"],
      });
  });
  await fixture.db.insert(entitlements).values({
    id: createId(),
    organizationId: fixture.tenant.organizationId,
    clientId,
    resource: second,
    scopes: ["mail:read"],
  });
  return second;
}

async function tokenRows() {
  return {
    access: await fixture.db.$count(oauthAccessTokens),
    refresh: await fixture.db.$count(oauthRefreshTokens),
    issued: await fixture.db.$count(
      auditEvents,
      eq(auditEvents.action, "oauth.user.issued"),
    ),
  };
}

test("authorize refuses a malformed request before writing a flow", async () => {
  const rows: [string, Record<string, string | null>, string, string][] = [
    [
      "an unregistered redirect_uri",
      { redirect_uri: "https://evil.example/callback" },
      `${fixture.environment.betterAuthUrl}/error`,
      "invalid_redirect",
    ],
    [
      "an unknown resource",
      { resource: "https://unknown.example/mcp" },
      redirect,
      "invalid_target",
    ],
    [
      "a confidential client without a PKCE challenge",
      { code_challenge: null, code_challenge_method: null },
      redirect,
      "invalid_request",
    ],
  ];
  for (const [name, change, destination, error] of rows) {
    const query = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: redirect,
      scope: "openid offline_access mail:read",
      resource,
      state: "client-state",
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    });
    for (const [key, value] of Object.entries(change))
      if (value === null) query.delete(key);
      else query.set(key, value);
    const before = await fixture.db.select().from(verifications);
    const response = await request(`/oauth2/authorize?${query}`);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin + location.pathname, name).toBe(destination);
    expect(location.searchParams.get("error"), name).toBe(error);
    expect(location.searchParams.has("code"), name).toBe(false);
    expect(await fixture.db.select().from(verifications), name).toEqual(before);
  }
  expect(await fixture.db.$count(grantContexts)).toBe(0);
});

test("code exchange refuses a changed redirect, an expired code, another resource and wrong client authentication", async () => {
  const second = await linkSecondResource();
  const basic = (password: string) =>
    `Basic ${Buffer.from(`${clientId}:${password}`).toString("base64")}`;
  const expire = () =>
    fixture.db
      .update(verifications)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(
        sql`${verifications.value}::jsonb->>'type' = 'authorization_code'`,
      );
  const rows: {
    name: string;
    code?: () => Promise<string>;
    prepare?: () => Promise<unknown>;
    body?: Record<string, string>;
    authorization?: string;
    status: number;
    error: string;
  }[] = [
    {
      name: "a different redirect_uri",
      body: { redirect_uri: "https://client.example/other" },
      status: 400,
      error: "invalid_grant",
    },
    {
      name: "an expired code",
      prepare: expire,
      status: 400,
      error: "invalid_grant",
    },
    {
      name: "another linked resource",
      body: { resource: second },
      status: 400,
      error: "invalid_target",
    },
    {
      name: "a linked resource for a login-only code",
      code: () => authorize("openid email offline_access", null),
      body: { resource: second },
      status: 400,
      error: "invalid_target",
    },
    {
      name: "a wrong client secret",
      authorization: basic(`wrong-${secret}`),
      status: 401,
      error: "invalid_client",
    },
    {
      name: "client_secret_post for a client registered for basic",
      body: { client_id: clientId, client_secret: secret },
      authorization: "",
      status: 400,
      error: "invalid_client",
    },
  ];
  for (const row of rows) {
    const code = await (row.code ?? authorize)();
    await row.prepare?.();
    const response = await auth.handler(
      new Request(`${fixture.environment.betterAuthUrl}/auth/oauth2/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: row.authorization ?? basic(secret),
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirect,
          code_verifier: verifier,
          ...(row.code ? {} : { resource }),
          ...row.body,
        }),
      }),
    );
    expect(response.status, row.name).toBe(row.status);
    expect(await response.json(), row.name).toMatchObject({
      error: row.error,
    });
    expect(await tokenRows(), row.name).toEqual({
      access: 0,
      refresh: 0,
      issued: 0,
    });
  }
});

test("a correctly signed query cannot change the stored flow", async () => {
  const selection = await start();
  const forged = new URLSearchParams(selection.search.slice(1));
  forged.set("scope", "openid offline_access");
  forged.delete("sig");
  const canonical = new URLSearchParams(
    [...forged.entries()].sort(([a, x], [b, y]) =>
      a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1,
    ),
  );
  forged.set(
    "sig",
    await makeSignature(
      canonical.toString(),
      fixture.environment.betterAuthSecret,
    ),
  );
  const response = await request("/oauth2/continue", {
    oauth_query: forged.toString(),
    postLogin: true,
    memberId: fixture.principals.tenantAdmin.memberId,
  });
  expect(response.status).toBe(400);
  expect(await fixture.db.$count(grantContexts)).toBe(0);
  expect((await select(selection)).pathname).toBe("/consent");
});

test("user tokens carry an audience list, the authenticating session and no nonce after refresh", async () => {
  const issued = await issue();
  const access = decodeJwt(issued.access_token);
  expect(access.aud).toEqual([
    resource,
    `${fixture.environment.betterAuthUrl}/auth/oauth2/userinfo`,
  ]);
  const [grant] = await fixture.db.select().from(grantContexts);
  expect(access.sid).toBe(grant!.authenticationSessionId);
  expect(decodeJwt(issued.id_token).sid).toBeUndefined();
  const refreshed = await refresh(issued.refresh_token);
  expect(refreshed.status).toBe(200);
  const renewed = await refreshed.json();
  expect(renewed.id_token).toBeString();
  expect(decodeJwt(renewed.id_token).nonce).toBeUndefined();
});

test("signing-key rotation keeps the old key published and new tokens verifiable", async () => {
  const jwks = async () =>
    (
      await auth.handler(
        new Request(`${fixture.environment.betterAuthUrl}/auth/jwks`),
      )
    ).json();
  const first = await issue();
  const old = decodeProtectedHeader(first.access_token).kid!;
  await fixture.db
    .update(jwksTable)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(jwksTable.id, old));
  const second = await issue();
  const current = decodeProtectedHeader(second.access_token).kid!;
  expect(current).not.toBe(old);
  const published = await jwks();
  expect(published.keys.map((key: { kid: string }) => key.kid)).toEqual(
    expect.arrayContaining([old, current]),
  );
  const keys = createLocalJWKSet(published);
  for (const token of [first.access_token, second.access_token])
    await jwtVerify(token, keys, {
      issuer: fixture.environment.betterAuthUrl,
      audience: resource,
      typ: "at+jwt",
    });
});

test("the published verifier accepts the user and machine tokens this app issues", async () => {
  const fetch = (input: string | URL | Request, init?: RequestInit) =>
    auth.handler(new Request(input, init));
  const issuer = fixture.environment.betterAuthUrl;
  const user = await createIdVerifier({ issuer, resource, fetch })(
    (await issue()).access_token,
  );
  expect(user).toMatchObject({
    userId: fixture.principals.tenantAdmin.userId,
    organizationId: fixture.tenant.organizationId,
    membershipId: fixture.principals.tenantAdmin.memberId,
    clientId,
  });
  const machine = await createIdVerifier({
    issuer,
    resource: fixture.platform.adminResource,
    subjectType: "client",
    fetch,
  })(await fixture.mintMachineToken());
  expect(machine).toMatchObject({
    clientId: fixture.platform.client.clientId,
    organizationId: fixture.platform.organizationId,
  });
});

// Authority changes, replay cleanup and grant provenance on the production app.
async function grantInOutsider() {
  const userId = fixture.principals.tenantAdmin.userId;
  const memberId = createId();
  await fixture.db.insert(members).values({
    id: memberId,
    organizationId: fixture.outsider.organizationId,
    userId,
  });
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
        scopes: ["mail:read"],
      },
      {
        clientId,
        resource,
        grantKind: "refresh_token" as const,
        scopes: ["mail:read"],
      },
    ])
      await createCapability(context, fixture.outsider.organizationId, input);
  });
  await fixture.db.insert(entitlements).values([
    {
      id: createId(),
      organizationId: fixture.outsider.organizationId,
      clientId,
      scopes: ["openid", "offline_access"],
    },
    {
      id: createId(),
      organizationId: fixture.outsider.organizationId,
      clientId,
      resource,
      scopes: ["mail:read"],
    },
  ]);
  // A deliberate binding stands in for verified linking (held by verified-sso):
  // the B grant still needs its own sign-in at B's directory.
  await fixture.db.insert(accounts).values({
    id: createId(),
    userId,
    issuer: fixture.issuer.origin,
    providerId: fixture.outsider.slug,
    accountId: "tenant-admin-at-outsider",
  });
  fixture.issuer.enqueue({
    sub: "tenant-admin-at-outsider",
    email: "tenantadmin@outsider.example.com",
    email_verified: true,
  });
  const signedIn = await signInThroughIdp(fixture.app, {
    providerId: fixture.outsider.slug,
    callbackURL: `${fixture.trustedOrigin}/callback`,
  });
  const saved = browserCookie;
  browserCookie = signedIn.cookies
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  try {
    const consent = await select(await start(), memberId);
    const accepted = await request("/oauth2/consent", {
      oauth_query: consent.search.slice(1),
      accept: true,
    });
    const code = new URL((await accepted.json()).url).searchParams.get("code")!;
    const response = await exchange({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
      code_verifier: verifier,
      resource,
    });
    expect(response.status).toBe(200);
    return (await response.json()) as { refresh_token: string };
  } finally {
    browserCookie = saved;
  }
}

function refresh(token: string, clientSecret = secret) {
  return auth.handler(
    new Request(`${fixture.environment.betterAuthUrl}/auth/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: token,
        resource,
      }),
    }),
  );
}

const ssoInput = async () => {
  const [provider] = await fixture.db
    .select()
    .from(ssoProviders)
    .where(eq(ssoProviders.organizationId, fixture.tenant.organizationId));
  return {
    issuer: provider!.issuer,
    domain: provider!.domain,
    oidc: JSON.parse(provider!.oidcConfig!),
  };
};

const authorityChanges: {
  change: string;
  apply: (grant: typeof grantContexts.$inferSelect) => Promise<string | void>;
  outsider: "kept" | "denied";
  session: "kept" | "gone";
}[] = [
  {
    change: "membership removal and reinstatement",
    apply: async () => {
      await inTenant(fixture.db, fixture.tenant.organizationId, (context) =>
        removeMember(context, fixture.principals.tenantAdmin.memberId),
      );
      await inTenant(fixture.db, fixture.tenant.organizationId, (context) =>
        reinstateMember(context, fixture.principals.tenantAdmin.memberId),
      );
    },
    outsider: "kept",
    session: "kept",
  },
  {
    change: "organisation disable and re-enable",
    apply: async () => {
      await inPlatformWrite(fixture.db, (context) =>
        disableOrganization(context, fixture.tenant.organizationId),
      );
      await inPlatformWrite(fixture.db, (context) =>
        enableOrganization(context, fixture.tenant.organizationId),
      );
    },
    // The client is owned by the tenant; the outsider grant is not.
    outsider: "kept",
    session: "kept",
  },
  {
    change: "user disable and re-enable",
    apply: async () => {
      await inPlatformUsers(fixture.db, (context) =>
        disableUser(context, fixture.principals.tenantAdmin.userId),
      );
      await inPlatformUsers(fixture.db, (context) =>
        enableUser(context, fixture.principals.tenantAdmin.userId),
      );
    },
    outsider: "denied",
    session: "gone",
  },
  {
    change: "revocation of the authenticating session",
    apply: async (grant) => {
      await inPlatformUsers(fixture.db, (context) =>
        revokeUserSession(
          context,
          fixture.principals.tenantAdmin.userId,
          grant.authenticationSessionId,
        ),
      );
    },
    outsider: "kept",
    session: "gone",
  },
  {
    change: "revocation of every session",
    apply: async () => {
      await inPlatformUsers(fixture.db, (context) =>
        revokeUserSessions(context, fixture.principals.tenantAdmin.userId),
      );
    },
    outsider: "denied",
    session: "gone",
  },
  {
    change: "resource disable and re-enable",
    apply: async () => {
      await inPlatformWrite(fixture.db, (context) =>
        disableResource(context, resource),
      );
      await inPlatformWrite(fixture.db, (context) =>
        enableResource(context, resource),
      );
    },
    outsider: "denied",
    session: "kept",
  },
  {
    change: "client disable and re-enable",
    apply: async () => {
      await inPlatformWrite(fixture.db, (context) =>
        disableClient(context, clientId),
      );
      await inPlatformWrite(fixture.db, (context) =>
        enableClient(context, clientId),
      );
    },
    outsider: "denied",
    session: "kept",
  },
  {
    change: "client secret rotation",
    apply: async () =>
      (
        await inPlatformWrite(fixture.db, (context) =>
          rotateSecret(context, clientId),
        )
      ).clientSecret!,
    outsider: "denied",
    session: "kept",
  },
  ...(["create", "update", "delete"] as const).map((mode) => ({
    change: `SSO ${mode} and restore`,
    apply: async () => {
      const provider = await ssoInput();
      if (mode !== "create")
        await inPlatformWrite(fixture.db, (context) =>
          putSsoProvider(context, fixture.tenant.organizationId, provider),
        );
      await inPlatformWrite(fixture.db, async (context) => {
        if (mode === "delete")
          await deleteSsoProvider(context, fixture.tenant.organizationId);
        else
          await putSsoProvider(context, fixture.tenant.organizationId, {
            ...provider,
            oidc: { ...provider.oidc, clientSecret: "replacement-secret" },
          });
      });
      // Restoring the configuration must not revive the old authorisation.
      await inPlatformWrite(fixture.db, (context) =>
        putSsoProvider(context, fixture.tenant.organizationId, provider),
      );
    },
    outsider: "kept" as const,
    session: "kept" as const,
  })),
  {
    change: "refresh capability disable",
    apply: async () => {
      const [capability] = await fixture.db
        .select()
        .from(organizationCapabilities)
        .where(
          and(
            eq(
              organizationCapabilities.organizationId,
              fixture.tenant.organizationId,
            ),
            eq(organizationCapabilities.grantKind, "refresh_token"),
          ),
        );
      await inPlatformWrite(fixture.db, (context) =>
        updateCapability(
          context,
          fixture.tenant.organizationId,
          capability!.id,
          { status: "disabled" },
          capability!,
        ),
      );
    },
    outsider: "kept",
    session: "kept",
  },
];

for (const { change, apply, outsider, session } of authorityChanges)
  test(`${change} denies cached and rotated refresh in that tenant`, async () => {
    const a = await issue();
    const rotated = await refresh(a.refresh_token);
    expect(rotated.status).toBe(200);
    const next = await rotated.json();
    const b = await grantInOutsider();
    const [grant] = await fixture.db
      .select()
      .from(grantContexts)
      .where(eq(grantContexts.organizationId, fixture.tenant.organizationId));
    const newSecret = await apply(grant!);
    const issued = await fixture.db.$count(
      auditEvents,
      eq(auditEvents.action, "oauth.user.issued"),
    );
    for (const token of [a.refresh_token, next.refresh_token]) {
      const denied = await refresh(token, newSecret || secret);
      expect(denied.status).toBe(400);
      expect(await denied.json()).toMatchObject({ error: "invalid_grant" });
    }
    expect((await refresh(b.refresh_token, newSecret || secret)).status).toBe(
      outsider === "kept" ? 200 : 400,
    );
    expect(
      await fixture.db.$count(
        auditEvents,
        eq(auditEvents.action, "oauth.user.issued"),
      ),
    ).toBe(issued + (outsider === "kept" ? 1 : 0));
    expect(
      await fixture.db.$count(
        sessions,
        eq(sessions.id, grant!.authenticationSessionId),
      ),
    ).toBe(session === "kept" ? 1 : 0);
  });

// Erasure would remove the sessions, codes and token rows; a direct soft deletion
// leaves them, so only the issuing transaction can refuse.
const softDeletions = {
  user: () => softDeleteUser(fixture.db, fixture.principals.tenantAdmin.userId),
  client: () => softDeleteClient(fixture.db, clientId),
};

for (const [deleted, softDelete] of Object.entries(softDeletions))
  test(`the token endpoint issues nothing once the ${deleted} is soft-deleted`, async () => {
    const issued = await issue();
    const code = await authorize();
    await softDelete();
    const rows = async () => ({
      access: await fixture.db.$count(oauthAccessTokens),
      refresh: await fixture.db.$count(oauthRefreshTokens),
    });
    const before = await rows();
    const refused = { status: 400, error: "invalid_grant" };
    const expected =
      deleted === "client" ? { status: 401, error: "invalid_client" } : refused;
    for (const response of [
      await exchange({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirect,
        code_verifier: verifier,
        resource,
      }),
      await refresh(issued.refresh_token),
    ]) {
      expect(response.status).toBe(expected.status);
      expect(await response.json()).toMatchObject({ error: expected.error });
    }
    expect(await rows()).toEqual(before);
  });

async function failingDeletes<T>(table: string, run: () => Promise<T>) {
  await fixture.db.execute(
    sql`create function refuse_token_delete() returns trigger language plpgsql as $$ begin raise exception 'test token storage outage'; end $$`,
  );
  await fixture.db.execute(
    sql.raw(
      `create trigger refuse_token_delete before delete on ${table} for each row execute function refuse_token_delete()`,
    ),
  );
  try {
    return await run();
  } finally {
    await fixture.db.execute(
      sql.raw(`drop trigger refuse_token_delete on ${table}`),
    );
    await fixture.db.execute(sql`drop function refuse_token_delete()`);
  }
}

for (const outage of [
  { replay: "code", table: "oauth_refresh_tokens", login: false },
  { replay: "code", table: "oauth_access_tokens", login: true },
  { replay: "refresh", table: "oauth_refresh_tokens", login: false },
] as const)
  test(`${outage.replay} replay cleanup outage on ${outage.table} keeps the revocation and is retryable`, async () => {
    const code = await authorize(
      outage.login ? "openid email offline_access" : undefined,
      outage.login ? null : resource,
    );
    const input = {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
      code_verifier: verifier,
      ...(outage.login ? {} : { resource }),
    };
    const first = await exchange(input);
    expect(first.status).toBe(200);
    const issued = await first.json();
    const replay =
      outage.replay === "code"
        ? input
        : {
            grant_type: "refresh_token",
            refresh_token: issued.refresh_token,
            resource,
          };
    if (outage.replay === "refresh")
      expect((await exchange(replay)).status).toBe(200);
    const before = {
      refresh: await fixture.db.select().from(oauthRefreshTokens),
      access: await fixture.db.select().from(oauthAccessTokens),
    };
    const failed = await failingDeletes(outage.table, () => exchange(replay));
    expect(failed.status).toBe(503);
    expect(failed.headers.get("retry-after")).toBe("1");
    expect(await failed.json()).toMatchObject({
      error: "temporarily_unavailable",
    });
    const [grant] = await fixture.db.select().from(grantContexts);
    expect(grant!.revokedAt).toBeInstanceOf(Date);
    expect(await fixture.db.select().from(oauthRefreshTokens)).toEqual(
      before.refresh,
    );
    expect(await fixture.db.select().from(oauthAccessTokens)).toEqual(
      before.access,
    );
    const retried = await exchange(replay);
    expect(retried.status).toBe(400);
    expect(await retried.json()).toMatchObject({ error: "invalid_grant" });
    expect(
      (
        await exchange({
          grant_type: "refresh_token",
          refresh_token: issued.refresh_token,
          ...(outage.login ? {} : { resource }),
        })
      ).status,
    ).toBe(400);
  });

const replays: {
  name: string;
  scope?: string;
  prepare?: (grantId: string) => Promise<unknown>;
  client?: string;
  revoked: boolean;
}[] = [
  {
    name: "after its token rows have disappeared",
    prepare: (grantId) =>
      fixture.db
        .delete(oauthRefreshTokens)
        .where(eq(oauthRefreshTokens.referenceId, grantId)),
    revoked: true,
  },
  {
    name: "for a JWT-only grant without stored tokens",
    scope: "openid mail:read",
    revoked: true,
  },
  {
    name: "by another authenticated client",
    client: "code-replay-other-client",
    revoked: false,
  },
];
for (const { name, scope, prepare, client, revoked } of replays)
  test(`code replay ${name} ${revoked ? "revokes" : "leaves"} the grant`, async () => {
    const code = await authorize(scope);
    const input = {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
      code_verifier: verifier,
      resource,
    };
    const first = await exchange(input);
    expect(first.status).toBe(200);
    const issued = await first.json();
    const grantId = String(decodeJwt(issued.access_token).grant_id);
    if (!issued.refresh_token)
      expect(await fixture.db.$count(oauthRefreshTokens)).toBe(0);
    await prepare?.(grantId);
    if (client) {
      const [original] = await fixture.db
        .select()
        .from(oauthClients)
        .where(eq(oauthClients.clientId, clientId));
      await fixture.db
        .insert(oauthClients)
        .values({ ...original!, id: createId(), clientId: client });
    }
    const rows = await fixture.db.select().from(oauthRefreshTokens);
    const replay = await auth.handler(
      new Request(`${fixture.environment.betterAuthUrl}/auth/oauth2/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${Buffer.from(`${client ?? clientId}:${secret}`).toString("base64")}`,
        },
        body: new URLSearchParams(input),
      }),
    );
    expect(replay.status).toBe(400);
    const [grant] = await fixture.db
      .select()
      .from(grantContexts)
      .where(eq(grantContexts.id, grantId));
    expect(Boolean(grant!.revokedAt)).toBe(revoked);
    if (!revoked) {
      expect(await fixture.db.select().from(oauthRefreshTokens)).toEqual(rows);
      expect((await refresh(issued.refresh_token)).status).toBe(200);
    }
  });

test("grant provenance and code binding cannot be forged, rewritten or revived", async () => {
  const issued = await issue();
  const id = String(decodeJwt(issued.access_token).grant_id);
  const [grant] = await fixture.db
    .select()
    .from(grantContexts)
    .where(eq(grantContexts.id, id));
  const refused = (constraint: string) => ({ cause: { constraint } });
  for (const patch of [
    { organizationId: fixture.outsider.organizationId },
    { authorizationCodeId: null },
    { authorizationCodeId: "replacement" },
    { requestedScopes: ["openid"] },
    { clientInstanceId: createId() },
    { authenticationSessionId: createId() },
    { authenticationAccountId: createId() },
    { upstreamAuthTime: new Date(0) },
    { expiresAt: new Date(Date.now() + 86400000) },
  ])
    await expect(
      fixture.db
        .update(grantContexts)
        .set(patch)
        .where(eq(grantContexts.id, id))
        .execute(),
    ).rejects.toMatchObject(refused("grant_context_immutable"));
  for (const patch of [
    { organizationId: fixture.outsider.organizationId },
    { authenticationSessionId: createId() },
    { authTime: new Date(0) },
    { authenticationAccountId: createId() },
    { authenticationProviderId: createId() },
    {
      authenticationProviderRevision: grant!.authenticationProviderRevision + 1,
    },
    { upstreamAuthTime: new Date(0) },
  ])
    await expect(
      fixture.db
        .insert(grantContexts)
        .values({
          ...grant!,
          ...patch,
          id: createId(),
          authorizationCodeId: null,
        })
        .execute(),
    ).rejects.toMatchObject(refused("grant_context_provenance"));
  await expect(
    fixture.db
      .insert(grantContexts)
      .values({ ...grant!, id: createId() })
      .execute(),
  ).rejects.toMatchObject(
    refused("grant_contexts_authorization_code_id_unique"),
  );
  await expect(
    bindGrantCode(fixture.db, createId(), "missing"),
  ).rejects.toMatchObject({
    body: { error: "invalid_grant" },
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
  ).rejects.toMatchObject(refused("grant_contexts_code_check"));
  await fixture.db
    .update(grantContexts)
    .set({ revokedAt: new Date() })
    .where(eq(grantContexts.id, freshId));
  await expect(
    bindGrantCode(fixture.db, freshId, "late-binding"),
  ).rejects.toMatchObject({
    body: { error: "invalid_grant" },
  });
  for (const patch of [
    { authorizationCodeId: "late-binding" },
    { revokedAt: null },
  ])
    await expect(
      fixture.db
        .update(grantContexts)
        .set(patch)
        .where(eq(grantContexts.id, freshId))
        .execute(),
    ).rejects.toMatchObject(refused("grant_context_immutable"));
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

test("grant RLS scopes isolate tenants, clients and admission sessions and restore pooled settings", async () => {
  await issue();
  await grantInOutsider();
  const [a] = await fixture.db
    .select()
    .from(grantContexts)
    .where(eq(grantContexts.organizationId, fixture.tenant.organizationId));
  const [b] = await fixture.db
    .select()
    .from(grantContexts)
    .where(eq(grantContexts.organizationId, fixture.outsider.organizationId));
  const sessionId = a!.authenticationSessionId;
  const ids = (rows: { id: string }[]) => rows.map((row) => row.id).sort();
  const read = (tx: Executor) =>
    tx.select({ id: grantContexts.id }).from(grantContexts);
  const both = [a!.id, b!.id].sort();
  expect(await read(runtime.db)).toEqual([]);
  for (const [organizationId, expected] of [
    [a!.organizationId, a!.id],
    [b!.organizationId, b!.id],
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
  // Grants are permanent: the runtime role cannot delete one in any scope.
  await expect(
    withDatabaseScope(runtime.db, { kind: "platform", access: "write" }, (tx) =>
      tx.delete(grantContexts).returning(),
    ),
  ).rejects.toMatchObject({ cause: { code: "42501" } });
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

// Lock-order races on the production locks. One side is held inside its
// transaction while the other waits for its row locks; the database, not a test
// hook, decides the order. A token request pauses at its issuance audit and a
// grant creation after its insert, both still holding every lock they took.
type PlatformContext = Parameters<Parameters<typeof inPlatformWrite>[1]>[0];
type UsersContext = Parameters<Parameters<typeof inPlatformUsers>[1]>[0];
type Writer = {
  setup?: () => Promise<unknown>;
} & (
  | { users?: false; apply: (context: PlatformContext) => Promise<unknown> }
  | { users: true; apply: (context: UsersContext) => Promise<unknown> }
);
const pauseKey = 4_242;

async function until(db: Database, condition: () => SQL) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const result = await db.execute(sql`select (${condition()}) as reached`);
    if (result.rows[0]!.reached) return;
    await Bun.sleep(10);
  }
  throw new Error("The race never reached its waiting state");
}

async function race<T>(
  first: "writer" | "other",
  writer: Writer,
  other: () => Promise<T>,
) {
  await writer.setup?.();
  const writerDatabase = createDatabase({
    ...fixture.environment,
    databasePoolMax: 2,
  });
  const holder = createDatabase({ ...fixture.environment, databasePoolMax: 1 });
  const resume = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let writerPid = 0;
  const write = (pause: boolean) => {
    const body = async (context: { tx: Executor }) => {
      const pid = await context.tx.execute(sql`select pg_backend_pid() as pid`);
      writerPid = Number(pid.rows[0]!.pid);
      const result = await (
        writer.apply as (context: { tx: Executor }) => Promise<unknown>
      )(context);
      if (pause) {
        entered.resolve();
        await resume.promise;
      }
      return result;
    };
    return writer.users
      ? inPlatformUsers(writerDatabase.db, body)
      : inPlatformWrite(writerDatabase.db, body);
  };
  const settle = (work: () => Promise<T>) =>
    work().then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
  try {
    if (first === "writer") {
      const changed = write(true);
      await Promise.race([entered.promise, changed]);
      const waiting = settle(other);
      await until(
        holder.db,
        () =>
          sql`exists(select 1 from pg_stat_activity where ${writerPid} = any(pg_blocking_pids(pid)))`,
      );
      resume.resolve();
      return { written: await changed, outcome: await waiting };
    }
    const key = sql.raw(String(pauseKey));
    await fixture.db.execute(
      sql`create function pause_for_race() returns trigger language plpgsql as $$ begin if TG_TABLE_NAME = 'audit_events' then if NEW.action = 'oauth.user.issued' then perform pg_advisory_xact_lock(${key}); end if; else perform pg_advisory_xact_lock(${key}); end if; return NEW; end $$`,
    );
    for (const table of ["audit_events", "grant_contexts"])
      await fixture.db.execute(
        sql.raw(
          `create trigger pause_for_race after insert on ${table} for each row execute function pause_for_race()`,
        ),
      );
    await holder.db.execute(sql`select pg_advisory_lock(${pauseKey})`);
    const waiting = settle(other);
    await until(
      holder.db,
      () =>
        sql`exists(select 1 from pg_locks where locktype = 'advisory' and objid = ${pauseKey} and not granted)`,
    );
    const changed = write(false);
    await until(
      holder.db,
      () => sql`cardinality(pg_blocking_pids(${writerPid})) > 0`,
    );
    await holder.db.execute(sql`select pg_advisory_unlock(${pauseKey})`);
    const outcome = await waiting;
    return { written: await changed, outcome };
  } finally {
    resume.resolve();
    if (first === "other") {
      for (const table of ["audit_events", "grant_contexts"])
        await fixture.db.execute(
          sql.raw(`drop trigger if exists pause_for_race on ${table}`),
        );
      await fixture.db.execute(sql`drop function if exists pause_for_race()`);
    }
    await holder.close();
    await writerDatabase.close();
  }
}

async function tenantCapability() {
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
  return capability!;
}

async function browserSessionId() {
  const [session] = await fixture.db
    .select()
    .from(sessions)
    .where(eq(sessions.userId, fixture.principals.tenantAdmin.userId));
  return session!.id;
}

const putProvider = async () => {
  const input = await ssoInput();
  await inPlatformWrite(fixture.db, (context) =>
    putSsoProvider(context, fixture.tenant.organizationId, input),
  );
};
const changedProvider = async (context: PlatformContext) =>
  putSsoProvider(context, fixture.tenant.organizationId, {
    ...(await ssoInput()),
    domain: "changed.example.com",
  });
const issuanceWriters: Record<string, Writer> = {
  capability: {
    apply: async (context) => {
      const capability = await tenantCapability();
      return updateCapability(
        context,
        capability.organizationId,
        capability.id,
        { status: "disabled" },
        capability,
      );
    },
  },
  "client-scopes": {
    apply: (context) =>
      updateClient(context, clientId, { scopes: ["openid", "offline_access"] }),
  },
  "resource-scopes": {
    apply: (context) =>
      updateResource(context, resource, { allowedScopes: ["unrelated"] }),
  },
  unlink: { apply: (context) => unlinkResource(context, clientId, resource) },
  "disable-client": { apply: (context) => disableClient(context, clientId) },
  "disable-resource": {
    apply: (context) => disableResource(context, resource),
  },
  "sso-create": { apply: changedProvider },
  "sso-update": { setup: putProvider, apply: changedProvider },
  "sso-delete": {
    setup: putProvider,
    apply: (context) =>
      deleteSsoProvider(context, fixture.tenant.organizationId),
  },
  "rotate-secret": { apply: (context) => rotateSecret(context, clientId) },
  disable: {
    users: true,
    apply: (context) =>
      disableUser(context, fixture.principals.tenantAdmin.userId),
  },
  session: {
    users: true,
    apply: async (context) =>
      revokeUserSession(
        context,
        fixture.principals.tenantAdmin.userId,
        await browserSessionId(),
      ),
  },
  "all-sessions": {
    users: true,
    apply: (context) =>
      revokeUserSessions(context, fixture.principals.tenantAdmin.userId),
  },
};

async function pendingIssuance(kind: "authorization_code" | "refresh_token") {
  if (kind === "authorization_code") {
    const code = await authorize();
    return () =>
      exchange({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirect,
        code_verifier: verifier,
        resource,
      });
  }
  const existing = await issue();
  return () => refresh(existing.refresh_token);
}

for (const kind of ["authorization_code", "refresh_token"] as const)
  for (const [change, writer] of Object.entries(issuanceWriters))
    test(`${kind} issuance holding its locks commits before ${change}, which then denies refresh`, async () => {
      const issuance = await pendingIssuance(kind);
      const { written, outcome } = await race("other", writer, issuance);
      if ("error" in outcome) throw outcome.error;
      expect(outcome.value.status).toBe(200);
      const issued = await outcome.value.json();
      const denied = await refresh(
        issued.refresh_token,
        change === "rotate-secret"
          ? (written as { clientSecret: string }).clientSecret
          : secret,
      );
      expect(denied.status).toBe(change === "disable-client" ? 401 : 400);
    });

for (const [kind, change] of [
  ...Object.keys(issuanceWriters).map(
    (change) => ["authorization_code", change] as const,
  ),
  ["refresh_token", "rotate-secret"] as const,
])
  test(`${change} committing first denies a ${kind} request already waiting for its locks`, async () => {
    const issuance = await pendingIssuance(kind);
    const refreshRows = await fixture.db.$count(oauthRefreshTokens);
    const { outcome } = await race(
      "writer",
      issuanceWriters[change]!,
      issuance,
    );
    if ("error" in outcome) throw outcome.error;
    expect(outcome.value.status).toBe(400);
    expect(await outcome.value.json()).toMatchObject({
      error: "invalid_grant",
    });
    expect(await fixture.db.$count(oauthRefreshTokens)).toBe(refreshRows);
  });

test("lock contention on each authority row is retryable without consuming the code", async () => {
  const quick = createDatabase({
    ...fixture.environment,
    databaseUrl: runtime.pool.options.connectionString!,
    databasePoolMax: 2,
    databaseLockTimeoutMs: 100,
  });
  const app = createApp({
    auth: createAuth(quick.db, fixture.environment),
    db: quick.db,
    environment: fixture.environment,
  });
  const holder = createDatabase({ ...fixture.environment, databasePoolMax: 1 });
  try {
    for (const [table, column, id] of [
      [users, users.id, fixture.principals.tenantAdmin.userId],
      [organizations, organizations.id, fixture.tenant.organizationId],
      [oauthClients, oauthClients.clientId, clientId],
      [oauthResources, oauthResources.identifier, resource],
    ] as const) {
      const code = await authorize();
      const redeem = () =>
        app.request("/auth/oauth2/token", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`,
          },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: redirect,
            code_verifier: verifier,
            resource,
          }),
        });
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const held = holder.db.transaction(async (tx) => {
        await tx
          .select()
          .from(table)
          .where(eq(column as typeof users.id, id))
          .for("update");
        entered.resolve();
        await resume.promise;
      });
      try {
        await entered.promise;
        const response = await redeem();
        expect(response.status, String(id)).toBe(503);
        expect(response.headers.get("retry-after")).toBe("1");
        expect(await response.json()).toMatchObject({
          error: "temporarily_unavailable",
        });
      } finally {
        resume.resolve();
        await held;
      }
      expect((await redeem()).status, String(id)).toBe(200);
    }
  } finally {
    await holder.close();
    await quick.close();
  }
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
] as const;

async function creationRace(
  first: "writer" | "other",
  change: (typeof creationChanges)[number],
) {
  const target = clientId;
  const userId = fixture.principals.tenantAdmin.userId;
  const sessionId = await browserSessionId();
  const writers: Record<(typeof creationChanges)[number], Writer> = {
    unlink: { apply: (context) => unlinkResource(context, target, resource) },
    "remove-member": {
      apply: (context) =>
        inTenant(context.tx, fixture.tenant.organizationId, (tenant) =>
          removeMember(tenant, fixture.principals.tenantAdmin.memberId),
        ),
    },
    "disable-user": {
      users: true,
      apply: (context) => disableUser(context, userId),
    },
    "disable-tenant": {
      apply: (context) =>
        disableOrganization(context, fixture.tenant.organizationId),
    },
    "revoke-session": {
      users: true,
      apply: (context) => revokeUserSession(context, userId, sessionId),
    },
    "revoke-all-sessions": {
      users: true,
      apply: (context) => revokeUserSessions(context, userId),
    },
    "disable-client": { apply: (context) => disableClient(context, target) },
    "disable-resource": {
      apply: (context) => disableResource(context, resource),
    },
  };
  const { outcome } = await race(first, writers[change], () =>
    runtime.db.transaction((tx) =>
      createResourceGrant(
        tx,
        {
          userId,
          sessionId,
          memberId: fixture.principals.tenantAdmin.memberId,
          clientId: target,
          resource,
          scopes: ["openid", "mail:read"],
        },
        60,
      ),
    ),
  );
  return { target, outcome };
}

for (const change of creationChanges)
  test(`${change} committing first prevents a waiting resource grant creation`, async () => {
    const { outcome } = await creationRace("writer", change);
    expect(outcome).toMatchObject({
      error: { body: { error: "access_denied" } },
    });
    expect(await fixture.db.$count(grantContexts)).toBe(0);
  });

for (const change of creationChanges)
  test(`resource grant creation commits before ${change}, whose policy then denies the stored context`, async () => {
    const { target, outcome } = await creationRace("other", change);
    if ("error" in outcome) throw outcome.error;
    const stored = await fixture.db.select().from(grantContexts);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.revokedAt !== null).toBe(change !== "unlink");
    expect(
      await userResourcePolicy(fixture.db, {
        id: outcome.value.id,
        clientId: target,
        resource,
        grantType: "authorization_code",
        requestedScopes: ["openid", "mail:read"],
      }),
    ).toMatchObject({ allowed: false });
  });

const tenantCapabilities = (...conditions: SQL[]) =>
  and(
    eq(organizationCapabilities.organizationId, fixture.tenant.organizationId),
    eq(organizationCapabilities.clientId, clientId),
    ...conditions,
  );
const pairEntitlement = () =>
  and(
    eq(entitlements.organizationId, fixture.tenant.organizationId),
    eq(entitlements.clientId, clientId),
    eq(entitlements.resource, resource),
  );
const substitutions: Record<string, () => Promise<unknown>> = {
  login: () =>
    fixture.db
      .delete(organizationCapabilities)
      .where(
        tenantCapabilities(sql`${organizationCapabilities.resource} is null`),
      ),
  "login-scope": () =>
    fixture.db
      .update(organizationCapabilities)
      .set({ scopes: ["offline_access"] })
      .where(
        tenantCapabilities(sql`${organizationCapabilities.resource} is null`),
      ),
  pair: () =>
    fixture.db
      .delete(organizationCapabilities)
      .where(
        tenantCapabilities(
          eq(organizationCapabilities.resource, resource),
          eq(organizationCapabilities.grantKind, "authorization_code"),
        ),
      ),
  expired: () =>
    fixture.db
      .update(organizationCapabilities)
      .set({ validUntil: new Date(Date.now() - 1000) })
      .where(
        tenantCapabilities(eq(organizationCapabilities.resource, resource)),
      ),
  future: () =>
    fixture.db
      .update(organizationCapabilities)
      .set({ validFrom: new Date(Date.now() + 60000) })
      .where(
        tenantCapabilities(eq(organizationCapabilities.resource, resource)),
      ),
  compatibility: () =>
    fixture.db
      .delete(oauthClientResources)
      .where(
        and(
          eq(oauthClientResources.clientId, clientId),
          eq(oauthClientResources.resourceId, resource),
        ),
      ),
  "empty-vocabulary": () =>
    fixture.db
      .update(oauthResources)
      .set({ allowedScopes: null })
      .where(eq(oauthResources.identifier, resource)),
  "resource-only": async () => {
    await fixture.db.delete(entitlements).where(pairEntitlement());
    await fixture.db.insert(entitlements).values({
      id: createId(),
      organizationId: fixture.tenant.organizationId,
      clientId: null,
      resource,
      scopes: ["mail:read"],
    });
  },
  "other-client": async () => {
    await fixture.db.delete(entitlements).where(pairEntitlement());
    await fixture.db.insert(oauthClients).values({
      id: createId(),
      clientId: "other-policy-client",
      redirectUris: [],
      scopes: ["mail:read"],
    });
    await fixture.db.insert(entitlements).values({
      id: createId(),
      organizationId: fixture.tenant.organizationId,
      clientId: "other-policy-client",
      resource,
      scopes: ["mail:read"],
    });
  },
  scope: () =>
    fixture.db
      .update(entitlements)
      .set({ scopes: ["unapproved:scope"] })
      .where(pairEntitlement()),
};

for (const [mode, substitute] of Object.entries(substitutions))
  test(`code exchange refuses ${mode} authority substitution`, async () => {
    const code = await authorize();
    await substitute();
    const response = await exchange({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
      code_verifier: verifier,
      resource,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
    expect(await tokenRows()).toEqual({ access: 0, refresh: 0, issued: 0 });
  });

test("user policy decision preserves exact sources and rejects widening its original context", async () => {
  const issued = await issue();
  const id = String(decodeJwt(issued.access_token).grant_id);
  const decision = await userResourcePolicy(fixture.db, {
    id,
    clientId,
    resource,
    grantType: "refresh_token",
    requestedScopes: ["openid", "offline_access", "mail:read"],
  });
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
    requestedScopes: ["mail:read", "offline_access", "openid"],
  });
  expect(decision.scopes).toEqual(["mail:read"]);
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
  const login = view.targets.find(
    (target) => target.kind === "client" && target.id === clientId,
  )!.permission;
  if (!login.allowed) throw new Error("Expected login admission");
  expect(login.evidence.capabilities).toEqual(
    decision.evidence.capabilities.filter(
      (capability) => capability.resource === null,
    ),
  );
  expect(login.evidence.assignments).toEqual(
    decision.evidence.assignments.filter(
      (assignment) => assignment.resource === null,
    ),
  );
  expect(
    await userResourcePolicy(fixture.db, {
      id,
      clientId,
      resource,
      grantType: "refresh_token",
      requestedScopes: ["mail:wider"],
    }),
  ).toMatchObject({
    allowed: false,
    reason: "scope",
    grantType: "refresh_token",
    scopes: [],
    organization: decision.organization,
    subject: decision.subject,
    client: decision.client,
    resource: decision.resource,
    requestedScopes: ["mail:wider"],
    evidence: { policyVersion: 1, membership: decision.evidence.membership },
  });
  expect(
    await userResourcePolicy(fixture.db, {
      id: createId(),
      clientId,
      resource,
      grantType: "refresh_token",
      requestedScopes: ["mail:read"],
    }),
  ).toEqual({ allowed: false, reason: "context" });
});

test("group-derived pair permission records its membership evidence and stops when the group is disabled", async () => {
  const organizationId = fixture.tenant.organizationId;
  const groupId = createId();
  const membershipId = createId();
  await fixture.db.delete(entitlements).where(pairEntitlement());
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
    scopes: ["mail:read"],
  });
  const issued = await issue();
  const decision = await userResourcePolicy(fixture.db, {
    id: String(decodeJwt(issued.access_token).grant_id),
    clientId,
    resource,
    grantType: "refresh_token",
    requestedScopes: ["openid", "offline_access", "mail:read"],
  });
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
  const rotated = await refresh(issued.refresh_token);
  expect(rotated.status).toBe(200);
  await fixture.db
    .update(groups)
    .set({ status: "disabled" })
    .where(eq(groups.id, groupId));
  expect((await refresh((await rotated.json()).refresh_token)).status).toBe(
    400,
  );
});

test("a grant records the authenticating session and caps later refresh at the requested scopes", async () => {
  await authorize("openid mail:read");
  const [context] = await fixture.db.select().from(grantContexts);
  expect(context!.requestedScopes).toEqual(["mail:read", "openid"]);
  expect(context!.authenticationSessionId).toBe(await browserSessionId());
  expect(
    await userResourcePolicy(fixture.db, {
      id: context!.id,
      clientId,
      resource,
      grantType: "refresh_token",
      requestedScopes: ["openid", "offline_access", "mail:read"],
    }),
  ).toMatchObject({ allowed: false, reason: "scope" });
});

test("resource grant creation admits only current, consistent authority", async () => {
  const sessionId = await browserSessionId();
  const input = {
    userId: fixture.principals.tenantAdmin.userId,
    sessionId,
    memberId: fixture.principals.tenantAdmin.memberId,
    clientId,
    resource,
    scopes: ["openid", "mail:read"],
  };
  const privateResource = `https://${createId()}.example/private`;
  const refusals: [
    string,
    Partial<typeof input>,
    ((tx: Executor) => Promise<unknown>)?,
  ][] = [
    ["another user", { userId: fixture.principals.platformAdmin.userId }],
    ["another member", { memberId: fixture.principals.platformAdmin.memberId }],
    ["another session", { sessionId: createId() }],
    ["an unknown client", { clientId: "unknown-client" }],
    ["an unknown resource", { resource: "https://missing.example/resource" }],
    ["no scopes", { scopes: [] }],
    ["an unregistered scope", { scopes: ["not-registered"] }],
    [
      "an expired membership",
      {},
      (tx) =>
        tx
          .update(members)
          .set({ validUntil: new Date(Date.now() - 1000) })
          .where(eq(members.id, input.memberId)),
    ],
    [
      "an expired session",
      {},
      (tx) =>
        tx
          .update(sessions)
          .set({ expiresAt: new Date(Date.now() - 1000) })
          .where(eq(sessions.id, sessionId)),
    ],
    [
      "a disabled user",
      {},
      (tx) =>
        tx
          .update(users)
          .set({ status: "disabled", disabledAt: new Date() })
          .where(eq(users.id, input.userId)),
    ],
    [
      "a disabled tenant",
      {},
      (tx) =>
        tx
          .update(organizations)
          .set({ status: "disabled", disabledAt: new Date() })
          .where(eq(organizations.id, fixture.tenant.organizationId)),
    ],
    [
      "a disabled client",
      {},
      (tx) =>
        tx
          .update(oauthClients)
          .set({ disabled: true })
          .where(eq(oauthClients.clientId, clientId)),
    ],
    [
      "a disabled resource",
      {},
      (tx) =>
        tx
          .update(oauthResources)
          .set({ disabled: true })
          .where(eq(oauthResources.identifier, resource)),
    ],
    [
      "an unsupported grant type",
      {},
      (tx) =>
        tx
          .update(oauthClients)
          .set({ grantTypes: ["refresh_token"] })
          .where(eq(oauthClients.clientId, clientId)),
    ],
    [
      "a client without scopes",
      {},
      (tx) =>
        tx
          .update(oauthClients)
          .set({ scopes: null })
          .where(eq(oauthClients.clientId, clientId)),
    ],
    [
      "another tenant's private resource",
      { resource: privateResource },
      async (tx) => {
        await tx.insert(oauthResources).values({
          id: createId(),
          identifier: privateResource,
          name: "Private",
          classification: "tenant_owned",
          organizationId: fixture.outsider.organizationId,
        });
        await tx
          .insert(oauthClientResources)
          .values({ id: createId(), clientId, resourceId: privateResource });
      },
    ],
  ];
  for (const [name, patch, change] of refusals)
    await fixture.db
      .transaction(async (tx) => {
        await change?.(tx);
        await expect(
          createResourceGrant(tx, { ...input, ...patch }, 60),
          name,
        ).rejects.toMatchObject({ body: { error: "access_denied" } });
        tx.rollback();
      })
      .catch((error: unknown) => {
        if (!(error instanceof TransactionRollbackError)) throw error;
      });
  expect(await fixture.db.$count(grantContexts)).toBe(0);
  const grant = await createResourceGrant(
    fixture.db,
    { ...input, scopes: ["mail:read", "openid", "mail:read"] },
    60,
  );
  expect(grant.requestedScopes).toEqual(["mail:read", "openid"]);
  expect(grant.organizationId).toBe(fixture.tenant.organizationId);
  expect(grant.expiresAt.getTime() - grant.createdAt.getTime()).toBe(60000);
});

test("resource grant creation times out on a held lock without partial state and then succeeds", async () => {
  const quick = createDatabase({
    ...fixture.environment,
    databasePoolMax: 1,
    databaseLockTimeoutMs: 100,
  });
  const holder = createDatabase({ ...fixture.environment, databasePoolMax: 1 });
  const input = {
    userId: fixture.principals.tenantAdmin.userId,
    sessionId: await browserSessionId(),
    memberId: fixture.principals.tenantAdmin.memberId,
    clientId,
    resource,
    scopes: ["openid", "mail:read"],
  };
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const held = holder.db.transaction(async (tx) => {
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
      createResourceGrant(quick.db, input, 60),
    ).rejects.toMatchObject({
      status: "SERVICE_UNAVAILABLE",
      body: { error: "temporarily_unavailable" },
    });
    expect(await fixture.db.$count(grantContexts)).toBe(0);
  } finally {
    resume.resolve();
    await held;
    await holder.close();
  }
  try {
    await createResourceGrant(quick.db, input, 60);
  } finally {
    await quick.close();
  }
  expect(await fixture.db.$count(grantContexts)).toBe(1);
});

test("the resource scope vocabulary filters issued scopes and identity claims stay in UserInfo", async () => {
  await fixture.db
    .update(oauthResources)
    .set({ allowedScopes: ["mail:read"] })
    .where(eq(oauthResources.identifier, resource));
  const issued = await issue();
  expect(issued.scope).toBe("mail:read");
  expect(issued.id_token).toBeUndefined();
  const [stored] = await fixture.db.select().from(oauthRefreshTokens);
  expect(stored!.scopes).toEqual(["mail:read"]);
  const login = await issue("openid email", null);
  expect(login.refresh_token).toBeUndefined();
  expect(decodeJwt(login.id_token).email).toBeUndefined();
  const userInfo = await request("/oauth2/userinfo", undefined, {
    authorization: `Bearer ${login.access_token}`,
  });
  expect(userInfo.status).toBe(200);
  expect((await userInfo.json()).email).toBe("tenantadmin@tenant.example.com");
});
