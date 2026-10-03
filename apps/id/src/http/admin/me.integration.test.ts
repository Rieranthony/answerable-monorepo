import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { describeAdminRoutes } from "../../__tests__/admin-routes.ts";
import { platformScopes } from "../../bootstrap.ts";
import { routes } from "./me.ts";
import { responseSchema } from "../../__tests__/openapi-response.ts";
const meSchema = responseSchema("getAdminMe", 200);

let fixture: AdminFixture;
beforeAll(async () => {
  fixture = await createAdminFixture({}, { restrictedRole: true });
});
afterAll(async () => {
  await fixture?.close();
});

describeAdminRoutes(routes, () => fixture);

test("getAdminMe: platform admin cookie", async () => {
  const response = await fixture.app.request("/api/admin/v1/me", {
    headers: fixture.headers("platformAdmin"),
  });
  expect(response.status).toBe(200);
  expect(meSchema.parse(await response.json())).toEqual({
    principal: {
      type: "user",
      userId: fixture.principals.platformAdmin.userId,
      email: "platformadmin@answerable.example.com",
      sessionId: expect.any(String),
    },
    grants: [
      {
        organizationId: fixture.platform.organizationId,
        organizationSlug: fixture.platform.slug,
        isPlatform: true,
        scopes: [...platformScopes],
      },
    ],
  });
});

test("getAdminMe: tenant reader cookie", async () => {
  const response = await fixture.app.request("/api/admin/v1/me", {
    headers: fixture.headers("tenantReader"),
  });
  expect(response.status).toBe(200);
  expect(meSchema.parse(await response.json())).toEqual({
    principal: {
      type: "user",
      userId: fixture.principals.tenantReader.userId,
      email: "tenantreader@tenant.example.com",
      sessionId: expect.any(String),
    },
    grants: [
      {
        organizationId: fixture.tenant.organizationId,
        organizationSlug: fixture.tenant.slug,
        isPlatform: false,
        scopes: ["org:read"],
      },
    ],
  });
});

test("getAdminMe: machine token", async () => {
  const response = await fixture.app.request("/api/admin/v1/me", {
    headers: fixture.headers({ bearer: await fixture.mintMachineToken() }),
  });
  expect(response.status).toBe(200);
  expect(meSchema.parse(await response.json())).toEqual({
    principal: {
      type: "client",
      clientId: fixture.platform.client.clientId,
      organizationId: fixture.platform.organizationId,
    },
    grants: [
      {
        organizationId: fixture.platform.organizationId,
        organizationSlug: fixture.platform.slug,
        isPlatform: true,
        scopes: [...platformScopes],
      },
    ],
  });
});

test("a real user-delegated access token for the admin resource is not an admin credential", async () => {
  const { createHash } = await import("node:crypto");
  const { decodeJwt } = await import("jose");
  const { createId } = await import("../../lib/id.ts");
  const { inPlatformWrite } =
    await import("../../__tests__/platform-context.ts");
  const { createCapability } = await import("../../services/capabilities.ts");
  const { hashClientSecret } = await import("../../services/client-secrets.ts");
  const { entitlements, oauthClientResources, oauthClients } =
    await import("../../db/schema/index.ts");
  const clientId = "admin-delegation";
  const secret = "admin-delegation-secret";
  const redirect = "https://delegation.example/callback";
  const verifier = "v".repeat(64);
  const resource = fixture.platform.adminResource;
  const organizationId = fixture.platform.organizationId;
  const admin = fixture.principals.platformAdmin;
  await fixture.db.insert(oauthClients).values({
    id: createId(),
    clientId,
    clientSecret: hashClientSecret(secret),
    name: "Delegation",
    organizationId,
    scopes: ["openid", "platform:read"],
    grantTypes: ["authorization_code"],
    responseTypes: ["code"],
    redirectUris: [redirect],
    tokenEndpointAuthMethod: "client_secret_basic",
    requirePKCE: true,
    skipConsent: false,
  });
  await fixture.db
    .insert(oauthClientResources)
    .values({ id: createId(), clientId, resourceId: resource });
  await inPlatformWrite(fixture.db, async (context) => {
    for (const [target, scopes] of [
      [null, ["openid"]],
      [resource, ["platform:read"]],
    ] as const)
      await createCapability(context, organizationId, {
        clientId,
        resource: target,
        grantKind: "authorization_code",
        scopes: [...scopes],
      });
  });
  await fixture.db.insert(entitlements).values([
    { id: createId(), organizationId, clientId, scopes: ["openid"] },
    {
      id: createId(),
      organizationId,
      clientId,
      resource,
      scopes: ["platform:read"],
    },
  ]);
  const auth = async (path: string, body?: Record<string, unknown>) => {
    const response = await fixture.app.request(`/auth${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        cookie: admin.cookie,
        origin: fixture.trustedOrigin,
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    expect(response.status, path).toBe(200);
    return new URL((await response.json()).url);
  };
  const selection = await auth(
    `/oauth2/authorize?${new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: redirect,
      scope: "openid platform:read",
      resource,
      state: "state",
      nonce: "nonce",
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    })}`,
  );
  const consent = await auth("/oauth2/continue", {
    oauth_query: selection.search.slice(1),
    postLogin: true,
    memberId: admin.memberId,
  });
  const callback = await auth("/oauth2/consent", {
    oauth_query: consent.search.slice(1),
    accept: true,
  });
  const issued = await fixture.app.request("/auth/oauth2/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: callback.searchParams.get("code")!,
      redirect_uri: redirect,
      code_verifier: verifier,
      resource,
    }),
  });
  expect(issued.status).toBe(200);
  const token = (await issued.json()).access_token as string;
  expect(decodeJwt(token)).toMatchObject({
    aud: expect.arrayContaining([resource]),
    subject_type: "user",
    scope: "platform:read",
    sid: expect.any(String),
  });
  const response = await fixture.app.request("/api/admin/v1/me", {
    headers: fixture.headers({ bearer: token }),
  });
  expect(response.status).toBe(401);
  expect(response.headers.get("WWW-Authenticate")).toBe(
    'Bearer error="invalid_token"',
  );
  expect(await response.json()).toMatchObject({ code: "invalid_token" });
});

test("platform authority and root lockout follow the binding after slugs change", async () => {
  const { organizations, entitlements } =
    await import("../../db/schema/index.ts");
  const { eq } = await import("drizzle-orm");
  const token = await fixture.mintMachineToken();
  const originalSlug = fixture.environment.platformOrganizationSlug;
  try {
    await fixture.db
      .update(organizations)
      .set({ slug: "renamed-platform" })
      .where(eq(organizations.id, fixture.platform.organizationId));
    await fixture.db
      .update(organizations)
      .set({ slug: originalSlug })
      .where(eq(organizations.id, fixture.tenant.organizationId));
    await fixture.db
      .update(entitlements)
      .set({ scopes: [...platformScopes] })
      .where(
        eq(entitlements.memberId, fixture.principals.tenantAdmin.memberId),
      );
    fixture.environment.platformOrganizationSlug = originalSlug;
    fixture.environment.rootAdminBreakGlass = false;
    for (const headers of [
      fixture.headers("platformAdmin"),
      fixture.headers({ bearer: token }),
    ])
      expect(
        (
          await fixture.app.request("/api/admin/v1/organizations", {
            headers,
          })
        ).status,
      ).toBe(200);
    expect(
      (
        await fixture.app.request("/api/admin/v1/organizations", {
          headers: fixture.headers("tenantAdmin"),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fixture.app.request("/api/admin/v1/me", {
          headers: {
            Authorization: `Bearer ${fixture.environment.rootAdminSecret}`,
          },
        })
      ).status,
    ).toBe(403);
  } finally {
    fixture.environment.rootAdminBreakGlass = true;
    await fixture.db
      .update(organizations)
      .set({ slug: fixture.tenant.slug })
      .where(eq(organizations.id, fixture.tenant.organizationId));
    await fixture.db
      .update(organizations)
      .set({ slug: fixture.platform.slug })
      .where(eq(organizations.id, fixture.platform.organizationId));
  }
});
