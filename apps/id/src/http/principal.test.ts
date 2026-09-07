import { describe, expect, mock, spyOn, test } from "bun:test";
import { Hono } from "hono";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWTPayload,
} from "jose";
import type { AuditEventInput } from "../db/queries/audit.ts";
import type { Auth } from "../auth.ts";
import {
  stubAuth,
  stubDatabase,
  testEnvironment,
} from "../__tests__/support.ts";
import type { ClientPrincipalRow } from "../db/queries/oauth-clients.ts";
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
  clientId: "client",
  disabled: false,
  organizationId: "org",
  organization: { id: "org", slug: "tenant", status: "active" },
  clientCredentialsScopes: ["org:read", "org:write", "unknown"],
};
const grants = [
  { organizationId: "org", organizationSlug: "tenant", scopes: ["org:read"] },
];
function setup(overrides: Partial<PrincipalDeps> = {}) {
  const deps: PrincipalDeps = {
    hasPlatformWriter: mock(async () => false),
    getSession: mock(async () => session),
    verifyBearer: mock(async () => ({
      clientId: "client",
      scopes: ["org:read"],
    })),
    loadGrants: mock(async () => grants),
    findClient: mock(async () => client),
    ...overrides,
  };
  const rows: AuditEventInput[] = [];
  const db = Object.assign(stubDatabase(), {
    insert: () => ({
      values: (row: AuditEventInput) => {
        rows.push(row);
        return { returning: async () => [row] };
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
      verifyBearer: async () => ({ clientId: "client", scopes: [], sid: "" }),
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
    expect(deps.findClient).toHaveBeenCalledWith(db, "client");
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
        { userId: "user" },
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
  test("validates claims and identity fallback, issuer, audience, type and expiry", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const getKey = createLocalJWKSet({ keys: [await exportJWK(publicKey)] });
    const verify = createBearerVerifier({
      getKey,
      issuer: "https://issuer",
      audience: "admin",
    });
    async function token(payload: JWTPayload = {}, typ = "at+jwt") {
      return new SignJWT({
        iss: "https://issuer",
        aud: "admin",
        sub: "sub-client",
        exp: Math.floor(Date.now() / 1000) + 60,
        ...payload,
      })
        .setProtectedHeader({ alg: "RS256", typ })
        .sign(privateKey);
    }
    expect(
      await verify(
        await token({
          azp: "azp-client",
          client_id: "other",
          scope: "org:read  org:write",
          sid: "session",
        }),
      ),
    ).toEqual({
      clientId: "azp-client",
      scopes: ["org:read", "org:write"],
      sid: "session",
    });
    expect(await verify(await token({ client_id: "fallback" }))).toEqual({
      clientId: "fallback",
      scopes: [],
      sid: undefined,
    });
    expect(await verify(await token())).toEqual({
      clientId: "sub-client",
      scopes: [],
      sid: undefined,
    });
    for (const payload of [
      { aud: "wrong" },
      { iss: "wrong" },
      { exp: 1 },
      { sub: undefined },
      { azp: 12 },
      { azp: "" },
    ]) {
      await expect(verify(await token(payload))).rejects.toThrow();
    }
    await expect(verify(await token({}, "JWT"))).rejects.toThrow();
  });
  test("caches for five minutes, retries rotated keys once, and propagates other failures", async () => {
    const first = await generateKeyPair("RS256");
    const second = await generateKeyPair("RS256");
    const firstJwk = { ...(await exportJWK(first.publicKey)), kid: "first" };
    const secondJwk = { ...(await exportJWK(second.publicKey)), kid: "second" };
    let keys = [firstJwk];
    const getJwks = mock(async () => ({ keys }));
    const auth = { api: { getJwks } } as unknown as Auth;
    const getKey = createJwksResolver(auth);
    const flattened = { payload: "", signature: "" };
    await getKey({ alg: "RS256", kid: "first" }, flattened);
    await getKey({ alg: "RS256", kid: "first" }, flattened);
    expect(getJwks).toHaveBeenCalledTimes(1);
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now + 300_001);
    try {
      await getKey({ alg: "RS256", kid: "first" }, flattened);
    } finally {
      clock.mockRestore();
    }
    expect(getJwks).toHaveBeenCalledTimes(2);
    keys = [secondJwk];
    await getKey({ alg: "RS256", kid: "second" }, flattened);
    expect(getJwks).toHaveBeenCalledTimes(3);
    await expect(
      getKey({ alg: "RS256", kid: "missing" }, flattened),
    ).rejects.toThrow();
    expect(getJwks).toHaveBeenCalledTimes(4);
    await expect(getKey({ alg: "HS256" }, flattened)).rejects.toThrow();
    expect(getJwks).toHaveBeenCalledTimes(4);
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
      organizationSlug: environment.platformOrganizationSlug,
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
  expect(rows[0]).toMatchObject({
    actorType: "system",
    actorId: "root",
    action: "admin.root_request",
    outcome: "denied",
    reason: "root_locked",
    targetType: "route",
    targetId: "/",
    requestId: "request",
    ip: "192.0.2.1",
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
