import { APIError } from "better-auth/api";
import { describe, expect, mock, spyOn, test } from "bun:test";
import { Hono } from "hono";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  jwtVerify,
  SignJWT,
  type JWTPayload,
} from "jose";
import type { AuditEventInput } from "../__tests__/audit-queries.ts";
import type { ClientPrincipalRow } from "../__tests__/client-queries.ts";
import {
  stubAuth,
  stubDatabase,
  testEnvironment,
} from "../__tests__/support.ts";
import type { Auth } from "../auth.ts";
import type { AppEnvironment } from "./context.ts";
import {
  createBearerVerifier,
  createDefaultPrincipalDeps,
  createJwksResolver,
  createPrincipalMiddleware,
  type PrincipalDeps,
} from "./principal.ts";
import { problemHandler } from "./problem.ts";

const session = {
  session: { id: "session" },
  user: { id: "user", email: "user@example.com", status: "active" },
};
const client: ClientPrincipalRow = {
  id: "instance",
  authorizationVersion: 1,
  isPlatform: false,
  clientId: "client",
  disabled: false,
  organizationId: "org",
  organization: {
    id: "org",
    slug: "tenant",
    status: "active",
    authorizationVersion: 1,
  },
  clientCredentialsScopes: ["org:read", "org:write", "unknown"],
  resourceScopes: null,
};
const grants = [
  {
    organizationId: "org",
    organizationSlug: "tenant",
    isPlatform: false,
    scopes: ["org:read"],
  },
];
const verifiedIdentity = {
  expiresAt: Math.floor(Date.now() / 1000) + 60,
  clientInstance: "instance",
  organizationId: "org",
  authorizationVersion: 1,
  organizationAuthorizationVersion: 1,
};
function setup(overrides: Partial<PrincipalDeps> = {}) {
  const deps: PrincipalDeps = {
    hasPlatformWriter: mock(async () => false),
    getSession: mock(async () => session),
    verifyBearer: mock(async () => ({
      ...verifiedIdentity,
      clientId: "client",
      scopes: ["org:read"],
    })),
    loadGrants: mock(async () => grants),
    findClient: mock(async () => client),
    ...overrides,
  };
  const rows: AuditEventInput[] = [];
  const db = Object.assign(stubDatabase(), {
    execute: async () => ({ rows: [{ occurredAt: "2026-09-11T00:00:00Z" }] }),
    insert: () => ({
      values: (row: AuditEventInput) => {
        rows.push(row);
        return Promise.resolve();
      },
    }),
  });
  const environment = testEnvironment({
    trustedOrigins: ["https://trusted.example"],
  });
  const app = new Hono<AppEnvironment>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("environment", environment);
    c.set("requestId", "request");
    c.set("clientIp", "192.0.2.1");
    await next();
  });
  app.use("*", createPrincipalMiddleware(deps));
  app.all("/", (c) => c.json(c.get("principal")));
  app.onError(problemHandler);
  return { app, deps, db, environment, rows };
}
async function assertProblem(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ code, request_id: "request" });
}
const bearer = { Authorization: "Bearer token", Cookie: "ignored" };

describe("unit: principal", () => {
  test("requires credentials and advertises bearer authentication", async () => {
    const { app } = setup({ getSession: async () => null });
    const response = await app.request("/");
    await assertProblem(response, 401, "unauthenticated");
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer realm="answerable-id-admin"',
    );
  });
  test.each(["Bearer", "Bearer two tokens", "Bearer\ttoken"])(
    "rejects malformed %s without consulting cookies",
    async (Authorization) => {
      const { app, deps } = setup();
      const response = await app.request("/", { headers: { Authorization } });
      await assertProblem(response, 401, "invalid_token");
      expect(response.headers.get("www-authenticate")).toBe(
        'Bearer error="invalid_token"',
      );
      expect(deps.getSession).not.toHaveBeenCalled();
    },
  );
  test("maps verifier failures to invalid_token", async () => {
    const { app } = setup({
      verifyBearer: async () => {
        throw new Error("bad JWT");
      },
    });
    const response = await app.request("/", { headers: bearer });
    await assertProblem(response, 401, "invalid_token");
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer error="invalid_token"',
    );
  });
  test.each([
    [null, 401, "invalid_token"],
    [{ ...client, disabled: true }, 401, "invalid_token"],
    [
      { ...client, organizationId: null, organization: null },
      403,
      "client_unowned",
    ],
    [
      {
        ...client,
        organization: { ...client.organization!, status: "disabled" },
      },
      403,
      "organization_disabled",
    ],
    [{ ...client, organization: null }, 403, "organization_disabled"],
  ] as const)("checks client state %#", async (row, status, code) => {
    const { app } = setup({ findClient: async () => row });
    const response = await app.request("/", { headers: bearer });
    await assertProblem(response, status, code);
    expect(response.headers.get("www-authenticate")).toBe(
      status === 401 ? 'Bearer error="invalid_token"' : null,
    );
  });
  test("rejects delegated credentials including an empty sid", async () => {
    const { app } = setup({
      verifyBearer: async () => ({
        ...verifiedIdentity,
        clientId: "client",
        scopes: [],
        sid: "",
      }),
    });
    const response = await app.request("/", { headers: bearer });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      code: "invalid_token",
      detail: "User-delegated tokens are not admin credentials.",
    });
  });
  test("intersects and sorts scopes, ignores cookies and skips CSRF", async () => {
    const { app, deps, db } = setup({
      verifyBearer: async () => ({
        ...verifiedIdentity,
        clientId: "client",
        scopes: [
          "org:write",
          "unknown",
          "platform:read",
          "org:read",
          "org:read",
        ],
      }),
    });
    const response = await app.request("/", {
      method: "POST",
      headers: { ...bearer, Origin: "https://evil.example" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      type: "client",
      clientId: "client",
      organizationId: "org",
      grants: [{ ...grants[0], scopes: ["org:read", "org:write"] }],
    });
    expect(deps.findClient).toHaveBeenCalledWith(
      db,
      "client",
      testEnvironment().adminResourceIdentifier,
    );
    expect(deps.getSession).not.toHaveBeenCalled();
    expect(deps.loadGrants).not.toHaveBeenCalled();
  });
  test("a null client scope ceiling grants no scopes", async () => {
    const { app } = setup({
      findClient: async () => ({ ...client, clientCredentialsScopes: null }),
    });
    expect(
      await (await app.request("/", { headers: bearer })).json(),
    ).toMatchObject({ grants: [{ ...grants[0], scopes: [] }] });
  });
  test("rejects inactive users", async () => {
    const { app } = setup({
      getSession: async () => ({
        ...session,
        user: { ...session.user, status: "inert" },
      }),
    });
    await assertProblem(await app.request("/"), 403, "user_disabled");
  });
  test("rejects untrusted origins", async () => {
    const { app, deps } = setup();
    await assertProblem(
      await app.request("/", { headers: { Origin: "https://evil.example" } }),
      403,
      "untrusted_origin",
    );
    expect(deps.loadGrants).not.toHaveBeenCalled();
  });
  test("requires an origin on writes", async () => {
    const { app } = setup();
    await assertProblem(
      await app.request("/", { method: "POST" }),
      403,
      "origin_required",
    );
  });
  test.each([undefined, "http://localhost:47300", "https://trusted.example"])(
    "accepts a cookie GET with origin %s",
    async (Origin) => {
      const { app, deps, db, environment } = setup();
      const response = await app.request("/", {
        headers: Origin ? { Origin } : {},
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        type: "user",
        userId: "user",
        email: "user@example.com",
        sessionId: "session",
        grants,
      });
      expect(deps.loadGrants).toHaveBeenCalledWith(
        db,
        { userId: "user", sessionId: "session" },
        environment.adminResourceIdentifier,
      );
    },
  );
  test.each(["POST", "HEAD", "OPTIONS"])(
    "allows safe methods or trusted-origin writes: %s",
    async (method) => {
      const { app } = setup();
      expect(
        (
          await app.request("/", {
            method,
            headers:
              method === "POST" ? { Origin: "https://trusted.example" } : {},
          })
        ).status,
      ).toBe(200);
    },
  );
  test("non-bearer authorization still uses the session", async () => {
    const { app } = setup();
    expect(
      (await app.request("/", { headers: { Authorization: "Basic abc" } }))
        .status,
    ).toBe(200);
  });
});

describe("unit: bearer verification and JWKS", () => {
  test("validates the machine identity contract, issuer, audience, type and expiry", async () => {
    const { privateKey, publicKey } = await generateKeyPair("EdDSA");
    const getKey = createLocalJWKSet({ keys: [await exportJWK(publicKey)] });
    const verify = createBearerVerifier({
      getKey,
      issuer: "https://issuer",
      audience: "admin",
    });
    const clientInstance = crypto.randomUUID();
    const organizationId = crypto.randomUUID();
    async function token(payload: JWTPayload = {}, typ = "at+jwt") {
      return new SignJWT({
        iss: "https://issuer",
        aud: "admin",
        sub: "client",
        client_id: "client",
        azp: "client",
        client_instance: clientInstance,
        organization_id: organizationId,
        authorization_version: 1,
        organization_authorization_version: 1,
        subject_type: "client",
        exp: Math.floor(Date.now() / 1000) + 60,
        ...payload,
      })
        .setProtectedHeader({ alg: "EdDSA", typ })
        .sign(privateKey);
    }
    expect(
      await verify(
        await token({ scope: "org:read  org:write", sid: "session" }),
      ),
    ).toEqual({
      clientId: "client",
      clientInstance,
      organizationId,
      expiresAt: expect.any(Number),
      authorizationVersion: 1,
      organizationAuthorizationVersion: 1,
      scopes: ["org:read", "org:write"],
      sid: "session",
    });
    expect(await verify(await token({ azp: undefined }))).toEqual({
      clientId: "client",
      clientInstance,
      organizationId,
      expiresAt: expect.any(Number),
      authorizationVersion: 1,
      organizationAuthorizationVersion: 1,
      scopes: [],
      sid: undefined,
    });
    for (const payload of [
      { aud: "wrong" },
      { iss: "wrong" },
      { exp: 1 },
      { exp: undefined },
      { sub: undefined },
      { sub: "another-client" },
      { client_id: undefined },
      { client_id: "" },
      { azp: 12 },
      { azp: "another-client" },
      { client_instance: undefined },
      { organization_id: undefined },
      { organization_authorization_version: undefined },
      { organization_authorization_version: 0 },
      { authorization_version: 0 },
      { authorization_version: 1.5 },
      { subject_type: "user" },
    ]) {
      await expect(verify(await token(payload))).rejects.toThrow();
    }
    await expect(verify(await token({}, "JWT"))).rejects.toThrow();
  });
  test("caches for five minutes, retries rotated keys once, and propagates other failures", async () => {
    const first = await generateKeyPair("EdDSA");
    const second = await generateKeyPair("EdDSA");
    const firstJwk = { ...(await exportJWK(first.publicKey)), kid: "first" };
    const secondJwk = { ...(await exportJWK(second.publicKey)), kid: "second" };
    let keys = [firstJwk];
    const getJwks = mock(async () => ({ keys }));
    const auth = { api: { getJwks } } as unknown as Auth;
    const getKey = createJwksResolver(auth);
    const flattened = { payload: "", signature: "" };
    await getKey({ alg: "EdDSA", kid: "first" }, flattened);
    await getKey({ alg: "EdDSA", kid: "first" }, flattened);
    expect(getJwks).toHaveBeenCalledTimes(1);
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now + 300_001);
    try {
      await getKey({ alg: "EdDSA", kid: "first" }, flattened);
    } finally {
      clock.mockRestore();
    }
    expect(getJwks).toHaveBeenCalledTimes(2);
    keys = [secondJwk];
    await getKey({ alg: "EdDSA", kid: "second" }, flattened);
    expect(getJwks).toHaveBeenCalledTimes(3);
    await expect(
      getKey({ alg: "EdDSA", kid: "missing" }, flattened),
    ).rejects.toThrow();
    expect(getJwks).toHaveBeenCalledTimes(3);
    await expect(getKey({ alg: "HS256" }, flattened)).rejects.toThrow();
    expect(getJwks).toHaveBeenCalledTimes(3);
  });
  test("concurrent cold and missing-key verification shares one load and never reloads a fresh miss", async () => {
    const pair = await generateKeyPair("EdDSA");
    const key = { ...(await exportJWK(pair.publicKey)), kid: "known" };
    let release = Promise.withResolvers<void>();
    let reached = Promise.withResolvers<void>();
    const getJwks = mock(async () => {
      reached.resolve();
      await release.promise;
      return { keys: [key] };
    });
    const getKey = createJwksResolver({ api: { getJwks } } as unknown as Auth);
    const token = { payload: "", signature: "" };
    for (const phase of ["cold", "cached"] as const) {
      const before = getJwks.mock.calls.length;
      const pending = Array.from({ length: 8 }, (_, index) =>
        getKey({ alg: "EdDSA", kid: `missing-${phase}-${index}` }, token),
      );
      const settled = Promise.allSettled(pending);
      try {
        await reached.promise;
        expect(getJwks.mock.calls.length - before).toBe(1);
      } finally {
        release.resolve();
        await settled;
      }
      expect(
        (await settled).every((result) => result.status === "rejected"),
      ).toBe(true);
      expect(getJwks.mock.calls.length - before).toBe(1);
      release = Promise.withResolvers<void>();
      reached = Promise.withResolvers<void>();
    }
    await getKey({ alg: "EdDSA", kid: "known" }, token);
    expect(getJwks).toHaveBeenCalledTimes(2);
  });
  test("concurrent rotated-key verification shares refresh while cached valid tokens still verify", async () => {
    const first = await generateKeyPair("EdDSA");
    const second = await generateKeyPair("EdDSA");
    const firstJwk = { ...(await exportJWK(first.publicKey)), kid: "first" };
    const secondJwk = { ...(await exportJWK(second.publicKey)), kid: "second" };
    const release = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    let rotating = false;
    const getJwks = mock(async () => {
      if (rotating) {
        reached.resolve();
        await release.promise;
      }
      return { keys: rotating ? [firstJwk, secondJwk] : [firstJwk] };
    });
    const getKey = createJwksResolver({ api: { getJwks } } as unknown as Auth);
    const old = await new SignJWT({ proof: "old" })
      .setProtectedHeader({ alg: "EdDSA", kid: "first" })
      .sign(first.privateKey);
    const current = await new SignJWT({ proof: "current" })
      .setProtectedHeader({ alg: "EdDSA", kid: "second" })
      .sign(second.privateKey);
    expect((await jwtVerify(old, getKey)).payload.proof).toBe("old");
    rotating = true;
    const pending = Array.from({ length: 8 }, () => jwtVerify(current, getKey));
    const settled = Promise.allSettled(pending);
    try {
      await reached.promise;
      expect(getJwks).toHaveBeenCalledTimes(2);
      expect((await jwtVerify(old, getKey)).payload.proof).toBe("old");
    } finally {
      release.resolve();
      await settled;
    }
    for (const result of await Promise.all(pending))
      expect(result.payload.proof).toBe("current");
    expect(getJwks).toHaveBeenCalledTimes(2);
  });
  test("failed shared key loads reject callers and allow the next request to recover", async () => {
    const pair = await generateKeyPair("EdDSA");
    const key = { ...(await exportJWK(pair.publicKey)), kid: "recovered" };
    const release = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    let fail = true;
    const getJwks = mock(async () => {
      reached.resolve();
      await release.promise;
      if (fail) throw new Error("synthetic unavailable key store");
      return { keys: [key] };
    });
    const getKey = createJwksResolver({ api: { getJwks } } as unknown as Auth);
    const token = { payload: "", signature: "" };
    const pending = Promise.allSettled(
      Array.from({ length: 8 }, () =>
        getKey({ alg: "EdDSA", kid: "recovered" }, token),
      ),
    );
    try {
      await reached.promise;
      expect(getJwks).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await pending;
    }
    expect(
      (await pending).every((result) => result.status === "rejected"),
    ).toBe(true);
    fail = false;
    await getKey({ alg: "EdDSA", kid: "recovered" }, token);
    expect(getJwks).toHaveBeenCalledTimes(2);
  });
  test("default deps use Better Auth's non-refreshing session API", async () => {
    const auth = stubAuth();
    const getSession = mock(async () => null);
    auth.api.getSession = getSession as unknown as Auth["api"]["getSession"];
    const deps = createDefaultPrincipalDeps({
      auth,
      environment: testEnvironment(),
    });
    const headers = new Headers({ Cookie: "session" });
    expect(await deps.getSession(headers)).toBeNull();
    expect(getSession).toHaveBeenCalledWith({
      headers,
      query: { disableRefresh: true },
    });
  });
});

const rootSecret = "test-root-secret-at-least-32-characters";
test.each(["GET", "POST"])(
  "root bearer skips JWT, session and CSRF on %s",
  async (method) => {
    const { app, deps, db, environment } = setup();
    environment.rootAdminSecret = rootSecret;
    const response = await app.request("/", {
      method,
      headers: { Authorization: `Bearer ${rootSecret}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ type: "root", grants: [] });
    expect(deps.hasPlatformWriter).toHaveBeenCalledWith(db, {
      resource: environment.adminResourceIdentifier,
    });
    expect(deps.verifyBearer).not.toHaveBeenCalled();
    expect(deps.findClient).not.toHaveBeenCalled();
    expect(deps.getSession).not.toHaveBeenCalled();
    expect(deps.loadGrants).not.toHaveBeenCalled();
  },
);
test.each([undefined, rootSecret])(
  "non-root bearer uses JWT with configured secret %s",
  async (configured) => {
    const verifyBearer = mock(async () => {
      throw new Error("bad JWT");
    });
    const { app, environment, deps } = setup({ verifyBearer });
    environment.rootAdminSecret = configured;
    const token = configured ? "wrong-secret" : rootSecret;
    await assertProblem(
      await app.request("/", { headers: { Authorization: `Bearer ${token}` } }),
      401,
      "invalid_token",
    );
    expect(verifyBearer).toHaveBeenCalledWith(token);
    expect(deps.hasPlatformWriter).not.toHaveBeenCalled();
  },
);
test("root lockout is audited once without credentials", async () => {
  const { app, environment, rows, deps } = setup({
    hasPlatformWriter: mock(async () => true),
  });
  environment.rootAdminSecret = rootSecret;
  const response = await app.request("/", {
    headers: {
      Authorization: `Bearer ${rootSecret}`,
      "x-forwarded-for": "192.0.2.1, 192.0.2.2",
      "user-agent": "test",
    },
  });
  expect(response.headers.get("content-type")).toContain(
    "application/problem+json",
  );
  expect(response.status).toBe(403);
  const body = await response.json();
  expect(body).toMatchObject({
    code: "root_locked",
    detail:
      "A platform administrator exists. Set ROOT_ADMIN_BREAK_GLASS=true to use the root secret.",
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]!.ip).toBe("192.0.2.1");
  expect(rows[0]).toMatchObject({
    actorType: "system",
    actorId: "root",
    action: "admin.root_request",
    outcome: "denied",
    reason: "root_locked",
    targetType: "route",
    targetId: "/",
    requestId: "request",
    userAgent: "test",
  });
  expect(JSON.stringify({ rows, body })).not.toContain(rootSecret);
  expect(deps.verifyBearer).not.toHaveBeenCalled();
});
test("break-glass skips the writer lookup", async () => {
  const { app, environment, deps } = setup();
  environment.rootAdminSecret = rootSecret;
  environment.rootAdminBreakGlass = true;
  expect(
    await (
      await app.request("/", {
        headers: { Authorization: `Bearer ${rootSecret}` },
      })
    ).json(),
  ).toEqual({ type: "root", grants: [] });
  expect(deps.hasPlatformWriter).not.toHaveBeenCalled();
});

test("session service failures are retryable without hiding unrelated errors", async () => {
  const auth = stubAuth();
  const deps = createDefaultPrincipalDeps({
    auth,
    environment: testEnvironment(),
  });
  for (const error of [
    new APIError("INTERNAL_SERVER_ERROR", { message: "Failed to get session" }),
    new APIError("BAD_REQUEST"),
    new Error("unexpected"),
  ]) {
    auth.api.getSession = (async () => {
      throw error;
    }) as unknown as Auth["api"]["getSession"];
    if (error instanceof APIError && error.status === "INTERNAL_SERVER_ERROR")
      await expect(deps.getSession(new Headers())).rejects.toMatchObject({
        status: 503,
        code: "authentication_unavailable",
      });
    else await expect(deps.getSession(new Headers())).rejects.toBe(error);
  }
});

test("HTTP admission rejects a verified token that expires during principal lookup", async () => {
  const expiresAt = Math.floor(Date.now() / 1000) + 60;
  const clock = spyOn(Date, "now");
  try {
    const { app } = setup({
      verifyBearer: async () => ({
        ...verifiedIdentity,
        expiresAt,
        clientId: "client",
        scopes: ["org:read"],
      }),
      findClient: async () => {
        clock.mockReturnValue((expiresAt + 1) * 1000);
        return client;
      },
    });
    const response = await app.request("/", {
      headers: { Authorization: "Bearer token" },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "invalid_token" });
  } finally {
    clock.mockRestore();
  }
});

for (const reason of [
  "invalid_token",
  "unauthenticated",
  "user_disabled",
  "untrusted_origin",
  "origin_required",
  "client_unowned",
  "organization_disabled",
] as const)
  test(`administrative ${reason} denial records bounded attribution without credentials`, async () => {
    const { app, rows } = setup({
      ...(reason === "invalid_token"
        ? {
            verifyBearer: async () => {
              throw new Error("bad token");
            },
          }
        : {}),
      ...(reason === "unauthenticated" ? { getSession: async () => null } : {}),
      ...(reason === "user_disabled"
        ? {
            getSession: async () => ({
              ...session,
              user: { ...session.user, status: "disabled" },
            }),
          }
        : {}),
      ...(reason === "client_unowned"
        ? { findClient: async () => ({ ...client, organizationId: null }) }
        : {}),
      ...(reason === "organization_disabled"
        ? { findClient: async () => ({ ...client, organization: null }) }
        : {}),
    });
    const clientFailure = ["client_unowned", "organization_disabled"].includes(
      reason,
    );
    const response = await app.request("/", {
      method: reason === "origin_required" ? "POST" : "GET",
      headers: {
        ...(clientFailure || reason === "invalid_token"
          ? bearer
          : { Cookie: "private-cookie" }),
        ...(reason === "untrusted_origin"
          ? { Origin: "https://evil.example" }
          : {}),
        "user-agent": "x".repeat(513),
      },
    });
    expect((await response.json()).code).toBe(reason);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorType: clientFailure ? "client" : "system",
      actorId: clientFailure ? "client" : "anonymous",
      action: "admin.auth_failed",
      reason,
      targetType: "route",
      targetId: "/",
      requestId: "request",
      ip: "192.0.2.1",
      userAgent: null,
      outcome: "denied",
    });
    expect(JSON.stringify(rows)).not.toContain("private-cookie");
    expect(JSON.stringify(rows)).not.toContain("Bearer token");
  });

test("unknown keys reload at most once per thirty seconds", async () => {
  const pair = await generateKeyPair("EdDSA");
  const getJwks = mock(async () => ({
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: "known" }],
  }));
  const resolver = createJwksResolver({ api: { getJwks } } as unknown as Auth);
  const known = await new SignJWT({})
    .setProtectedHeader({ alg: "EdDSA", kid: "known" })
    .sign(pair.privateKey);
  await jwtVerify(known, resolver);
  const now = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(now);
  try {
    for (const elapsed of [0, 1, 29_999, 30_000]) {
      clock.mockReturnValue(now + elapsed);
      const unknown = await new SignJWT({})
        .setProtectedHeader({ alg: "EdDSA", kid: `unknown-${elapsed}` })
        .sign(pair.privateKey);
      await expect(jwtVerify(unknown, resolver)).rejects.toThrow();
      expect(getJwks).toHaveBeenCalledTimes(elapsed === 30_000 ? 3 : 2);
    }
  } finally {
    clock.mockRestore();
  }
});

test("invalid bearer denial keeps the claimed client identity as unverified metadata", async () => {
  const { app, rows } = setup({
    verifyBearer: async () => {
      throw new Error("invalid signature");
    },
  });
  const token = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from('{"client_id":"claimed-client","private":"secret"}').toString("base64url")}.`;
  expect(
    (await app.request("/", { headers: { Authorization: `Bearer ${token}` } }))
      .status,
  ).toBe(401);
  expect(rows[0]).toMatchObject({
    actorType: "system",
    actorId: "anonymous",
    reason: "invalid_token",
    data: { claimedClientId: "claimed-client" },
  });
  expect(JSON.stringify(rows)).not.toContain("secret");
});

test("failed administrative authentication stays refused when its audit cannot be stored", async () => {
  const { app, db } = setup({ getSession: async () => null });
  const failure = spyOn(db, "insert").mockImplementation(() => {
    throw new Error("audit offline");
  });
  try {
    await assertProblem(await app.request("/"), 401, "unauthenticated");
  } finally {
    failure.mockRestore();
  }
});
