import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { startOidcIssuer, type OidcIssuer } from "../__tests__/oidc-issuer.ts";
import { testEnvironment } from "../__tests__/support.ts";
import { createApp, type App } from "../app.ts";
import { createAuth } from "../auth.ts";
import { bootstrap, type BootstrapResult } from "../bootstrap.ts";
import { createDatabase, type DatabaseConnection } from "../db/client.ts";
import {
  oauthClients,
  oauthClientResources,
  oauthResources,
} from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";
import { hashClientSecret } from "../services/client-secrets.ts";

let issuer: OidcIssuer;
let connection: DatabaseConnection;
let app: App;
let bootstrapped: BootstrapResult;
let secret: string;
const environment = testEnvironment();
const scopes = ["platform:read", "platform:users", "platform:write"];

beforeAll(async () => {
  issuer = await startOidcIssuer();
  connection = createDatabase(environment);
  await connection.db.execute(
    sql`truncate table users, organizations, oauth_clients, oauth_resources, audit_events cascade`,
  );
  app = createApp({
    auth: createAuth(connection.db, environment),
    db: connection.db,
    environment,
  });
  bootstrapped = await bootstrap(connection.db, {
    platformOrganizationSlug: environment.platformOrganizationSlug,
    platformOrganizationName: "Answerable",
    platformDomain: "answerable.example.com",
    sso: {
      issuer: issuer.origin,
      clientId: "platform-sso",
      clientSecret: "issuer-secret",
    },
    adminResourceIdentifier: environment.adminResourceIdentifier,
    bootstrapClientId: "token-bootstrap",
  });
  expect(bootstrapped.client.clientSecret).toBeString();
  secret = bootstrapped.client.clientSecret!;
});

afterAll(async () => {
  issuer.stop();
  await connection.close();
});

function mint({
  clientId = bootstrapped.client.clientId,
  secret: clientSecret = secret,
  body,
}: {
  clientId?: string;
  secret?: string;
  body: Record<string, string>;
}) {
  return app.request("/auth/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body),
  });
}

function tokenBody() {
  return {
    grant_type: "client_credentials",
    resource: environment.adminResourceIdentifier,
    scope: scopes.join(" "),
  };
}

function me(token: string) {
  return app.request("/api/admin/v1/me", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function mintedToken(body = tokenBody()) {
  const response = await mint({ body });
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.access_token).toBeString();
  return result.access_token as string;
}

async function expectProblem(token: string, status: number, code: string) {
  const response = await me(token);
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ code });
}

test("integration: a bootstrapped client mints a resource JWT and calls the admin API", async () => {
  const response = await mint({ body: tokenBody() });
  expect(response.status).toBe(200);
  const result = await response.json();
  // Bun 1.3.1: numeric matchers fail on an object that toMatchObject has
  // already compared against expect.any(), so assert the fields directly.
  expect(result.access_token).toBeString();
  expect(result.token_type).toBe("Bearer");
  expect(result.expires_in).toBeNumber();
  expect(result.expires_in).toBeGreaterThan(0);
  expect(result.expires_in).toBeLessThanOrEqual(600);
  expect(decodeProtectedHeader(result.access_token).typ).toBe("at+jwt");
  expect(decodeJwt(result.access_token)).toMatchObject({
    iss: environment.betterAuthUrl,
    aud: environment.adminResourceIdentifier,
    sub: bootstrapped.client.clientId,
    azp: bootstrapped.client.clientId,
    scope: scopes.join(" "),
  });
  const admin = await me(result.access_token);
  expect(admin.status).toBe(200);
  expect(await admin.json()).toEqual({
    principal: {
      type: "client",
      clientId: bootstrapped.client.clientId,
      organizationId: bootstrapped.organization.id,
    },
    grants: [
      {
        organizationId: bootstrapped.organization.id,
        organizationSlug: "answerable",
        scopes,
      },
    ],
  });
});

test("integration: a wrong client secret is rejected", async () => {
  const response = await mint({ secret: "wrong-secret", body: tokenBody() });
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({ error: "invalid_client" });
});

test("integration: a token without a resource is opaque and cannot call the admin API", async () => {
  const response = await mint({ body: { grant_type: "client_credentials" } });
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.access_token).toBeString();
  expect(() => decodeProtectedHeader(result.access_token)).toThrow();
  await expectProblem(result.access_token, 401, "invalid_token");
});

test("integration: scopes outside the client ceiling are rejected", async () => {
  const response = await mint({ body: { ...tokenBody(), scope: "org:write" } });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: "invalid_scope" });
});

test("integration: the public endpoint rejects authorization code grants", async () => {
  const response = await mint({ body: { grant_type: "authorization_code" } });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: "unsupported_grant_type",
  });
});

test("integration: disabling a client revokes admin access and prevents minting", async () => {
  const token = await mintedToken();
  await connection.db
    .update(oauthClients)
    .set({ disabled: true })
    .where(eq(oauthClients.clientId, bootstrapped.client.clientId));
  try {
    await expectProblem(token, 401, "invalid_token");
    const response = await mint({ body: tokenBody() });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "invalid_client" });
  } finally {
    await connection.db
      .update(oauthClients)
      .set({ disabled: false })
      .where(eq(oauthClients.clientId, bootstrapped.client.clientId));
  }
});

test("integration: an unowned client mints but cannot call the admin API", async () => {
  const clientId = "unowned-token-client";
  const clientSecret = "unowned-token-client-secret";
  await connection.db.insert(oauthClients).values({
    id: createId(),
    clientId,
    clientSecret: hashClientSecret(clientSecret),
    name: "Unowned machine",
    organizationId: null,
    redirectUris: [],
    grantTypes: ["client_credentials"],
    responseTypes: [],
    tokenEndpointAuthMethod: "client_secret_basic",
    scopes: [],
    clientCredentialsScopes: ["platform:read"],
    disabled: false,
  });
  await connection.db.insert(oauthClientResources).values({
    id: createId(),
    clientId,
    resourceId: environment.adminResourceIdentifier,
  });
  const response = await mint({
    clientId,
    secret: clientSecret,
    body: {
      grant_type: "client_credentials",
      resource: environment.adminResourceIdentifier,
    },
  });
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.access_token).toBeString();
  expect(decodeJwt(result.access_token).scope).toBe("platform:read");
  await expectProblem(result.access_token, 403, "client_unowned");
});

test("integration: an expired resource JWT cannot call the admin API", async () => {
  await connection.db
    .update(oauthResources)
    .set({ accessTokenTtl: 1 })
    .where(eq(oauthResources.id, bootstrapped.resource.id));
  try {
    const token = await mintedToken();
    await Bun.sleep(1500);
    await expectProblem(token, 401, "invalid_token");
  } finally {
    await connection.db
      .update(oauthResources)
      .set({ accessTokenTtl: 600 })
      .where(eq(oauthResources.id, bootstrapped.resource.id));
  }
});
