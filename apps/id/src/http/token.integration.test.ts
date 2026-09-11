import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { approveMachineCapability } from "../__tests__/capabilities.ts";
import { startOidcIssuer, type OidcIssuer } from "../__tests__/oidc-issuer.ts";
import { platformWriteService } from "../__tests__/platform-context.ts";
import { testEnvironment } from "../__tests__/support.ts";
import { createApp, type App } from "../app.ts";
import { createAuth } from "../auth.ts";
import {
  bootstrap,
  platformScopes,
  systemActor,
  type BootstrapResult,
} from "../bootstrap.ts";
import { createDatabase, type DatabaseConnection } from "../db/client.ts";
import {
  auditEvents,
  oauthClientResources,
  oauthClients,
  oauthResources,
} from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";
import { hashClientSecret } from "../services/client-secrets.ts";
import {
  createClient as createClientImplementation,
  linkResource as linkResourceImplementation,
} from "../services/clients.ts";
const createClient = platformWriteService(createClientImplementation);
const linkResource = platformWriteService(linkResourceImplementation);

let issuer: OidcIssuer;
let connection: DatabaseConnection;
let app: App;
let bootstrapped: BootstrapResult;
const clientId = "token-bootstrap";
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
  bootstrapped = await bootstrap(connection.db, systemActor("token-test"), {
    platformOrganizationSlug: environment.platformOrganizationSlug,
    platformOrganizationName: "Answerable",
    adminResourceIdentifier: environment.adminResourceIdentifier,
  });
  const client = await createClient(connection.db, systemActor("token-test"), {
    clientId,
    name: "Token test",
    organizationId: bootstrapped.organization.id,
    grantTypes: ["client_credentials"],
    tokenEndpointAuthMethod: "client_secret_basic",
    redirectUris: [],
    clientCredentialsScopes: [...platformScopes],
  });
  await linkResource(
    connection.db,
    systemActor("token-test"),
    clientId,
    environment.adminResourceIdentifier,
  );
  await approveMachineCapability(connection.db, {
    organizationId: bootstrapped.organization.id,
    clientId,
    resource: environment.adminResourceIdentifier,
    scopes: [...platformScopes],
  });
  expect(client.clientSecret).toBeString();
  secret = client.clientSecret!;
});

afterAll(async () => {
  issuer.stop();
  await connection.close();
});

function mint({
  clientId: mintClientId = clientId,
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
      Authorization: `Basic ${Buffer.from(`${mintClientId}:${clientSecret}`).toString("base64")}`,
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
    sub: clientId,
    azp: clientId,
    scope: scopes.join(" "),
  });
  const admin = await me(result.access_token);
  expect(admin.status).toBe(200);
  expect(await admin.json()).toEqual({
    principal: {
      type: "client",
      clientId: clientId,
      organizationId: bootstrapped.organization.id,
    },
    grants: [
      {
        organizationId: bootstrapped.organization.id,
        organizationSlug: "answerable",
        isPlatform: true,
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

test("integration: a token without a resource is rejected", async () => {
  const response = await mint({ body: { grant_type: "client_credentials" } });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: "invalid_target" });
});

test("integration: scopes outside the client ceiling are rejected", async () => {
  const response = await mint({ body: { ...tokenBody(), scope: "org:write" } });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: "invalid_scope" });
});

test("integration: a machine-only client cannot exchange authorization codes", async () => {
  const response = await mint({ body: { grant_type: "authorization_code" } });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: "unauthorized_client",
  });
});

test("integration: disabling a client revokes admin access and prevents minting", async () => {
  const token = await mintedToken();
  await connection.db
    .update(oauthClients)
    .set({ disabled: true })
    .where(eq(oauthClients.clientId, clientId));
  try {
    await expectProblem(token, 401, "invalid_token");
    const response = await mint({ body: tokenBody() });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "invalid_client" });
  } finally {
    await connection.db
      .update(oauthClients)
      .set({ disabled: false })
      .where(eq(oauthClients.clientId, clientId));
  }
});

test("integration: an unowned client cannot mint a token", async () => {
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
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({ error: "invalid_client" });
});

test("integration: an expired resource JWT cannot call the admin API", async () => {
  await connection.db
    .update(oauthResources)
    .set({ accessTokenTtl: 1 })
    .where(eq(oauthResources.id, bootstrapped.resource.id));
  try {
    const token = await mintedToken();
    setSystemTime(new Date(Date.now() + 60_000));
    await expectProblem(token, 401, "invalid_token");
  } finally {
    setSystemTime();
    await connection.db
      .update(oauthResources)
      .set({ accessTokenTtl: 600 })
      .where(eq(oauthResources.id, bootstrapped.resource.id));
  }
});

for (const malformed of [
  "duplicate-grant",
  "large-scope",
  "invalid-utf8",
  "json-form",
  "chunked",
] as const) {
  // A valid body may arrive chunked; the other four are refused. A client that
  // authenticated with its secret before its body was refused may be attributed;
  // a request refused before client authentication never is.
  test(`token endpoint handles a ${malformed} request safely`, async () => {
    const requestId = createId();
    const body = new URLSearchParams(tokenBody());
    if (malformed === "duplicate-grant")
      body.append("grant_type", "refresh_token");
    if (malformed === "large-scope") body.set("scope", "s".repeat(64 * 1024));
    const bytes =
      malformed === "invalid-utf8"
        ? new Uint8Array([
            ...new TextEncoder().encode(body + "&scope="),
            0xc3,
            0x28,
          ])
        : new TextEncoder().encode(body.toString());
    const response = await app.request("/auth/oauth2/token", {
      method: "POST",
      headers: {
        "x-request-id": requestId,
        "content-type":
          malformed === "json-form"
            ? "application/json"
            : "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`,
      },
      body:
        malformed === "chunked"
          ? new ReadableStream({
              start(controller) {
                controller.enqueue(bytes);
                controller.close();
              },
            })
          : bytes,
    });
    if (malformed === "chunked") expect(response.status).toBe(200);
    else {
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    }
    expect(response.headers.get("cache-control")).toBe("no-store");
    const events = await connection.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.requestId, requestId));
    if (malformed === "duplicate-grant" || malformed === "json-form")
      for (const event of events) {
        expect(event.actorId).not.toBe(clientId);
        expect(JSON.stringify(event.data)).not.toContain(clientId);
        expect(event.actorType).not.toBe("client");
      }
  });
}
