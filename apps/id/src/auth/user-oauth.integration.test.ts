import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { oauthProvider } from "@better-auth/oauth-provider";
import type { jwt } from "better-auth/plugins/jwt";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import {
  createLocalJWKSet,
  decodeJwt,
  exportJWK,
  generateKeyPair,
  jwtVerify,
  SignJWT,
} from "jose";
import { and, eq, sql } from "drizzle-orm";
import { createAdminFixture, type AdminFixture } from "../__tests__/admin.ts";
import { inPlatformWrite } from "../__tests__/platform-context.ts";
import { createAuth } from "../auth.ts";
import { createApp } from "../app.ts";
import { createDatabase } from "../db/client.ts";
import { configureRuntimeRole } from "../db/runtime-role.ts";
import {
  entitlements,
  oauthClients,
  oauthResources,
  oauthClientResources,
  auditEvents,
  auditEventSubjects,
  grantContexts,
  verifications,
  members,
  sessions,
  accounts,
  ssoProviders,
  oauthRefreshTokens,
  oauthAccessTokens,
  oauthConsents,
} from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";
import { createCapability } from "../services/capabilities.ts";
import { hashClientSecret } from "../services/client-secrets.ts";
import { currentGrantAuthentication } from "./grant-authentication.ts";

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
) {
  const query = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirect,
    scope,
    ...(target ? { resource: target } : {}),
    state: "client-state",
    nonce: "client-nonce",
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
  const redeem = (jwt: string, codeVerifier: string) =>
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
  expect((await redeem(await assertion(), verifier)).status).toBe(200);
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
  const final = await exchange({
    grant_type: "refresh_token",
    refresh_token: next.refresh_token,
    resource,
  });
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

test("registered resource custom claims cannot replace user authority", async () => {
  for (const field of [
    "membership_id",
    "grant_id",
    "resource_instance",
    "upstream_auth_time",
  ])
    await expect(
      fixture.db
        .update(oauthResources)
        .set({ customClaims: { [field]: "forged" } })
        .where(eq(oauthResources.identifier, resource))
        .execute(),
    ).rejects.toMatchObject({
      cause: { constraint: "oauth_resources_identity_claims_check" },
    });
});

for (const claim of [
  "membership_id",
  "grant_id",
  "resource_instance",
  "upstream_auth_time",
]) {
  test(`native access output with a divergent ${claim} rolls back code and audit`, async () => {
    const code = await authorize();
    const provider = auth.options.plugins.find(
      (plugin) => plugin.id === "oauth-provider",
    ) as ReturnType<typeof oauthProvider>;
    provider.options.customAccessTokenClaims = async () => ({
      [claim]: "forged",
    });
    const input = {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
      code_verifier: verifier,
      resource,
    };
    expect((await exchange(input)).status).toBe(400);
    expect(
      await fixture.db.$count(
        auditEvents,
        eq(auditEvents.action, "oauth.user.issued"),
      ),
    ).toBe(0);
    provider.options.customAccessTokenClaims = undefined;
    expect((await exchange(input)).status).toBe(200);
  });
}

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

test("missing native ID token rolls back code, refresh material and issuance audit", async () => {
  const code = await authorize();
  const signer = auth.options.plugins.find(
    (plugin) => plugin.id === "jwt",
  ) as ReturnType<typeof jwt>;
  const { privateKey } = await generateKeyPair("EdDSA");
  signer.options.jwks = {
    ...signer.options.jwks,
    keyPairConfig: { alg: "EdDSA" },
  };
  signer.options.jwt!.sign = async (payload, header) =>
    payload.nonce
      ? undefined!
      : new SignJWT(payload)
          .setProtectedHeader({ alg: "EdDSA", ...header })
          .sign(privateKey);
  const input = {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirect,
    code_verifier: verifier,
    resource,
  };
  expect((await exchange(input)).status).toBe(400);
  expect(await fixture.db.$count(oauthRefreshTokens)).toBe(0);
  expect(
    await fixture.db.$count(
      auditEvents,
      eq(auditEvents.action, "oauth.user.issued"),
    ),
  ).toBe(0);
  signer.options.jwt!.sign = undefined;
  expect((await exchange(input)).status).toBe(200);
});

test("divergent returned refresh persistence rolls back native rotation and audit", async () => {
  const issued = await issue();
  await fixture.db.execute(
    sql`create function corrupt_refresh_output() returns trigger language plpgsql as $$ begin NEW.scopes := ARRAY['email']; return NEW; end $$`,
  );
  await fixture.db.execute(
    sql`create trigger corrupt_refresh_output before insert on oauth_refresh_tokens for each row execute function corrupt_refresh_output()`,
  );
  const input = {
    grant_type: "refresh_token",
    refresh_token: issued.refresh_token,
    resource,
    scope: "mail:read",
  };
  try {
    expect((await exchange(input)).status).toBe(400);
    expect(await fixture.db.$count(oauthRefreshTokens)).toBe(1);
    expect(
      (await fixture.db.select().from(oauthRefreshTokens))[0]!.revoked,
    ).toBeNull();
    expect(
      await fixture.db.$count(
        auditEvents,
        eq(auditEvents.action, "oauth.user.issued"),
      ),
    ).toBe(1);
  } finally {
    await fixture.db.execute(
      sql`drop trigger corrupt_refresh_output on oauth_refresh_tokens`,
    );
    await fixture.db.execute(sql`drop function corrupt_refresh_output()`);
  }
  expect((await exchange(input)).status).toBe(200);
});

test("native JWT scope, lifetime, type and ID nonce or profile divergences preserve the code", async () => {
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
  for (const fault of [
    "access-scope",
    "access-expiry",
    "access-type",
    "id-expiry",
    "id-nonce",
    "id-access-hash",
    "id-email",
    "id-name",
  ] as const) {
    signer.options.jwt!.sign = async (payload, header) => {
      const changed = { ...payload };
      const isId = payload.nonce !== undefined;
      if (!isId && fault === "access-scope") changed.scope = "email";
      if (!isId && fault === "access-expiry")
        changed.exp = Number(payload.exp) + 60;
      if (isId && fault === "id-expiry") changed.exp = Number(payload.exp) + 60;
      if (isId && fault === "id-nonce") changed.nonce = "wrong-nonce";
      if (isId && fault === "id-access-hash")
        changed.at_hash = "wrong-access-hash";
      if (isId && fault === "id-email") changed.email = "private@example.com";
      if (isId && fault === "id-name") changed.name = "Unconsented name";
      return new SignJWT(changed)
        .setProtectedHeader({
          alg: "EdDSA",
          ...header,
          ...(!isId && fault === "access-type" ? { typ: "JWT" } : {}),
        })
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

test("opaque and refresh rows must match returned scopes, resource, reference and native expiry", async () => {
  const code = await authorize("openid email offline_access", null);
  const input = {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirect,
    code_verifier: verifier,
  };
  for (const [table, assignment] of [
    ["oauth_access_tokens", "NEW.scopes := ARRAY['openid']"],
    [
      "oauth_access_tokens",
      "NEW.resources := ARRAY['https://wrong.example/mcp']",
    ],
    [
      "oauth_access_tokens",
      "NEW.expires_at := NEW.expires_at + interval '1 second'",
    ],
    [
      "oauth_refresh_tokens",
      "NEW.resources := ARRAY['https://wrong.example/mcp']",
    ],
    ["oauth_refresh_tokens", "NEW.reference_id := 'wrong-grant'"],
    [
      "oauth_refresh_tokens",
      "NEW.expires_at := NEW.expires_at + interval '1 second'",
    ],
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

test("native configured expiry and identity-scope filtering determine the full returned contract", async () => {
  const provider = auth.options.plugins.find(
    (plugin) => plugin.id === "oauth-provider",
  ) as ReturnType<typeof oauthProvider>;
  provider.options.accessTokenExpiresIn = 120;
  provider.options.refreshTokenExpiresIn = 600;
  provider.options.idTokenExpiresIn = 180;
  provider.options.scopeExpirations = { "mail:read": "45s" };
  await fixture.db
    .update(oauthResources)
    .set({ refreshTokenTtl: 90, allowedScopes: ["mail:read"] });
  const issued = await issue();
  expect(issued.scope).toBe("mail:read");
  expect(issued.expires_in).toBe(45);
  expect(issued.id_token).toBeUndefined();
  const access = decodeJwt(issued.access_token);
  const [refresh] = await fixture.db.select().from(oauthRefreshTokens);
  expect(refresh!.scopes).toEqual(["mail:read"]);
  expect(refresh!.expiresAt.getTime() / 1000).toBe(access.iat! + 90);
  const login = await issue("openid email", null);
  expect(login.refresh_token).toBeUndefined();
  const id = decodeJwt(login.id_token);
  expect(id.exp! - id.iat!).toBe(180);
  expect(id.email).toBeUndefined();
  const userInfo = await request("/oauth2/userinfo", undefined, {
    authorization: `Bearer ${login.access_token}`,
  });
  expect(userInfo.status).toBe(200);
  expect((await userInfo.json()).email).toBe("tenantadmin@tenant.example.com");
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
    "missing-refresh",
    "unknown-refresh",
    "scope",
    "expires-at",
    "token-type",
    "stored-scope",
  ] as const) {
    const changed = structuredClone(replay);
    if (fault === "unexpected-id") changed.response.id_token = issued.id_token;
    if (fault === "missing-refresh") delete changed.response.refresh_token;
    if (fault === "unknown-refresh")
      changed.response.refresh_token = "not-a-stored-token";
    if (fault === "scope") changed.response.scope = "openid mail:read";
    if (fault === "expires-at") changed.response.expires_at += 60;
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

test("ID-token access hashes follow the configured native signing algorithm", async () => {
  const signer = auth.options.plugins.find(
    (plugin) => plugin.id === "jwt",
  ) as ReturnType<typeof jwt>;
  for (const alg of ["ES256", "ES512"] as const) {
    const { privateKey } = await generateKeyPair(alg);
    signer.options.jwks = { ...signer.options.jwks, keyPairConfig: { alg } };
    signer.options.jwt!.sign = (payload, header) =>
      new SignJWT(payload)
        .setProtectedHeader({ alg, ...header })
        .sign(privateKey);
    const issued = await issue("openid email", null);
    expect(typeof decodeJwt(issued.id_token).at_hash).toBe("string");
  }
});

test("native refresh authentication time must match retained broker evidence", async () => {
  const issued = await issue();
  await fixture.db.update(oauthRefreshTokens).set({ authTime: new Date(0) });
  const response = await exchange({
    grant_type: "refresh_token",
    refresh_token: issued.refresh_token,
    resource,
  });
  expect(response.status).toBe(400);
  expect(
    await fixture.db.$count(
      auditEvents,
      eq(auditEvents.action, "oauth.user.issued"),
    ),
  ).toBe(1);
  expect(await fixture.db.$count(oauthRefreshTokens)).toBe(1);
});

test("retained legacy or inconsistent authentication evidence cannot establish current authority", async () => {
  await issue();
  const [grant] = await fixture.db.select().from(grantContexts);
  expect(
    await currentGrantAuthentication(fixture.db, {
      ...grant!,
      authentication: null,
    }),
  ).toBeNull();
  expect(
    await currentGrantAuthentication(fixture.db, {
      ...grant!,
      authentication: { ...grant!.authentication!, memberId: createId() },
    }),
  ).toBeNull();
  expect(
    await currentGrantAuthentication(fixture.db, {
      ...grant!,
      revokedAt: new Date(),
    }),
  ).toBeNull();
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
    (await fixture.db.select().from(grantContexts))[0]!.authentication!
      .upstreamAuthTime,
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
  expect(grant!.authentication).toMatchObject({
    userId: fixture.principals.tenantAdmin.userId,
    memberId: fixture.principals.tenantAdmin.memberId,
    authenticationOrganizationId: fixture.tenant.organizationId,
    authenticationSessionId: grant!.authenticationSessionId,
    brokerAuthenticatedAt: grant!.authTime.toISOString(),
  });
  expect(decodeJwt(issued.id_token).auth_time).toBe(
    Math.floor(grant!.authTime.getTime() / 1000),
  );
  expect(decodeJwt(issued.id_token).upstream_auth_time).toBe(
    Math.floor(
      new Date(grant!.authentication!.upstreamAuthTime!).getTime() / 1000,
    ),
  );
  const refresh = await exchange({
    grant_type: "refresh_token",
    refresh_token: issued.refresh_token,
    resource,
  });
  expect(refresh.status).toBe(200);
  const renewed = await refresh.json();
  expect(renewed.refresh_token).not.toBe(issued.refresh_token);
  expect(decodeJwt(renewed.access_token).grant_id).toBe(
    decodeJwt(issued.access_token).grant_id,
  );
  const events = await fixture.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.schemaVersion, 4));
  expect(events.map((event) => event.action).sort()).toEqual([
    "oauth.user.authorized",
    "oauth.user.issued",
    "oauth.user.issued",
  ]);
  const subjects = await fixture.db
    .select()
    .from(auditEventSubjects)
    .where(
      eq(
        auditEventSubjects.eventId,
        events.find((event) => event.action === "oauth.user.issued")!.id,
      ),
    );
  expect(subjects).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        entityType: "member",
        entityId: fixture.principals.tenantAdmin.memberId,
        provenance: "recorded",
      }),
      expect.objectContaining({
        entityType: "user",
        entityId: fixture.principals.tenantAdmin.userId,
        relationship: "affected",
      }),
    ]),
  );
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
  expect(
    (
      await exchange({
        grant_type: "refresh_token",
        refresh_token: issued.refresh_token,
        resource,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await exchange({
        grant_type: "refresh_token",
        refresh_token: other.refresh_token,
        resource,
      })
    ).status,
  ).toBe(200);
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
  expect(
    (
      await exchange({
        grant_type: "refresh_token",
        refresh_token: first.refresh_token,
        resource,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await exchange({
        grant_type: "refresh_token",
        refresh_token: other.refresh_token,
        resource,
      })
    ).status,
  ).toBe(200);
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
    sql`create function reject_oauth_audit() returns trigger language plpgsql as $$ begin if NEW.schema_version = 4 then raise exception 'test audit storage failure'; end if; return NEW; end $$`,
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
  const refreshed = await exchange({
    grant_type: "refresh_token",
    refresh_token: issued.refresh_token,
    resource,
  });
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
  expect(
    (
      await exchange({
        grant_type: "refresh_token",
        refresh_token: issued.refresh_token,
        resource,
      })
    ).status,
  ).toBe(400);
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
  expect(
    (
      await exchange({
        grant_type: "refresh_token",
        refresh_token: a.refresh_token,
        resource,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await exchange({
        grant_type: "refresh_token",
        refresh_token: b.refresh_token,
        resource,
      })
    ).status,
  ).toBe(200);
});
