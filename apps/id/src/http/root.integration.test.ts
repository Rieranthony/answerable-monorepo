import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { createApp } from "../app.ts";
import { createAuth } from "../auth.ts";
import {
  bootstrap,
  platformAdminsGroupSlug,
  platformScopes,
  systemActor,
} from "../bootstrap.ts";
import { createDatabase, type DatabaseConnection } from "../db/client.ts";
import { auditEvents, users } from "../db/schema/index.ts";
import { signInThroughIdp } from "../__tests__/federation.ts";
import { startOidcIssuer } from "../__tests__/oidc-issuer.ts";
import { testEnvironment } from "../__tests__/support.ts";
import { adminScopes } from "./admin/scopes.ts";

let connection: DatabaseConnection;
let issuer: Awaited<ReturnType<typeof startOidcIssuer>>;
beforeAll(async () => {
  issuer = await startOidcIssuer();
  connection = createDatabase(testEnvironment());
  await connection.db.execute(
    sql`truncate table security_identifiers, audit_events, entitlements, group_members, groups,
      organization_domains, sso_providers, oauth_client_assertions,
      oauth_access_tokens, oauth_refresh_tokens, oauth_consents,
      oauth_client_resources, oauth_resources, oauth_clients, jwks,
      invitations, members, sessions, accounts, verifications, organizations, users cascade`,
  );
});
afterAll(async () => {
  issuer?.stop();
  await connection?.close();
});

test("integration: root locks after a human administrator and supports break-glass", async () => {
  const { db } = connection;
  const secret = "integration-root-secret-at-least-32-characters";
  const environment = testEnvironment({
    operationReplay: {
      activeKeyId: "test",
      keys: { test: Buffer.alloc(32, 3).toString("base64url") },
    },
    rootAdminSecret: secret,
    rootAdminBreakGlass: false,
    trustedOrigins: [issuer.origin, "https://console.example.com"],
  });
  const auth = createAuth(db, environment);
  const app = createApp({ db, auth, environment });
  const headers = {
    "Idempotency-Key": crypto.randomUUID(),
    Authorization: `Bearer ${secret}`,
    "x-forwarded-for": "192.0.2.1, 192.0.2.2",
    "user-agent": "root-test",
  };
  const me = "/api/admin/v1/me";
  for (const [instance, bearer] of [
    [app, "wrong-secret"],
    [
      createApp({
        db,
        auth,
        environment: { ...environment, rootAdminSecret: undefined },
      }),
      secret,
    ],
  ] as const) {
    const response = await instance.request(me, {
      headers: { Authorization: `Bearer ${bearer}` },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "invalid_token" });
  }
  const response = await app.request(me, { headers });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    principal: { type: "root", scopes: [...adminScopes] },
    grants: [],
  });
  const events = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.action, "admin.root_request"));
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    actorType: "system",
    actorId: "root",
    outcome: "success",
    targetId: "getAdminMe",
    ip: "127.0.0.1",
    userAgent: "root-test",
    requestId: response.headers.get("x-request-id"),
  });
  expect(events[0]!.requestId).toBeTruthy();
  const created = await app.request("/api/admin/v1/organizations", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ slug: "root-created", name: "Root created" }),
  });
  expect(created.status).toBe(201);
  const writes = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.action, "organization.created"));
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ actorType: "system", actorId: "root" });
  await bootstrap(db, systemActor("startup"), {
    platformOrganizationSlug: environment.platformOrganizationSlug,
    platformOrganizationName: "Answerable",
    adminResourceIdentifier: environment.adminResourceIdentifier,
  });
  expect((await app.request(me, { headers })).status).toBe(200);
  const organisationsResponse = await app.request(
    `/api/admin/v1/organizations?q=${environment.platformOrganizationSlug}`,
    { headers },
  );
  expect(organisationsResponse.status).toBe(200);
  const organisations = (await organisationsResponse.json()) as {
    items: { id: string; slug: string }[];
  };
  const platform = organisations.items.find(
    (row) => row.slug === environment.platformOrganizationSlug,
  )!;
  expect(platform).toBeDefined();
  const platformPath = `/api/admin/v1/organizations/${platform.id}`;
  const domain = await app.request(`${platformPath}/domains`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ domain: "answerable.example.com" }),
  });
  expect(domain.status).toBe(201);
  const provider = await app.request(`${platformPath}/sso-provider`, {
    method: "PUT",
    headers: {
      ...headers,
      "If-None-Match": "*",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      issuer: issuer.origin,
      domain: "answerable.example.com",
      oidc: { clientId: "platform-sso", clientSecret: "secret" },
    }),
  });
  expect(provider.status).toBe(201);
  const email = "admin@answerable.example.com";
  issuer.enqueue({
    sub: "root-test-admin",
    email,
    email_verified: true,
    name: "Administrator",
  });
  const callbackURL = "https://console.example.com/callback";
  const signedIn = await signInThroughIdp(app, {
    providerId: environment.platformOrganizationSlug,
    callbackURL,
  });
  expect(signedIn.location).toBe(callbackURL);
  expect(signedIn.cookies.length).toBeGreaterThan(0);
  expect((await app.request(me, { headers })).status).toBe(200);
  const groupsResponse = await app.request(`${platformPath}/groups`, {
    headers,
  });
  expect(groupsResponse.status).toBe(200);
  const groups = (await groupsResponse.json()) as {
    items: { id: string; slug: string }[];
  };
  const group = groups.items.find(
    (row) => row.slug === platformAdminsGroupSlug,
  )!;
  expect(group).toBeDefined();
  const membersResponse = await app.request(
    `${platformPath}/members?q=${encodeURIComponent(email)}`,
    { headers },
  );
  expect(membersResponse.status).toBe(200);
  const members = (await membersResponse.json()) as {
    items: { id: string; email: string }[];
  };
  expect(members.items).toHaveLength(1);
  expect(members.items[0]!.email).toBe(email);
  const staff = await app.request(
    `${platformPath}/groups/${group.id}/members/${members.items[0]!.id}`,
    {
      method: "PUT",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        "If-None-Match": "*",
      },
      body: "{}",
    },
  );
  expect(staff.status).toBe(201);
  const human = await app.request(me, {
    headers: {
      Cookie: signedIn.cookies
        .map((value) => value.split(";", 1)[0])
        .join("; "),
      Origin: "https://console.example.com",
    },
  });
  expect(human.status).toBe(200);
  expect(await human.json()).toMatchObject({
    principal: { type: "user", email },
    grants: [
      {
        organizationId: platform.id,
        organizationSlug: platform.slug,
        isPlatform: true,
        scopes: [...platformScopes],
      },
    ],
  });
  const before = new Set(
    (await db.select().from(auditEvents)).map((row) => row.id),
  );
  const locked = await app.request(me, { headers });
  expect(locked.status).toBe(403);
  expect(locked.headers.get("content-type")).toContain(
    "application/problem+json",
  );
  expect(await locked.json()).toMatchObject({ code: "root_locked" });
  const denied = (await db.select().from(auditEvents)).filter(
    (row) => !before.has(row.id),
  );
  expect(denied).toHaveLength(1);
  expect(denied[0]).toMatchObject({
    actorType: "system",
    actorId: "root",
    action: "admin.root_request",
    outcome: "denied",
    reason: "root_locked",
    targetId: me,
  });
  const breakGlass = createApp({
    db,
    auth,
    environment: { ...environment, rootAdminBreakGlass: true },
  });
  expect((await breakGlass.request(me, { headers })).status).toBe(200);
  await db
    .update(users)
    .set({ status: "disabled", disabledAt: new Date() })
    .where(eq(users.email, email));
  expect((await app.request(me, { headers })).status).toBe(200);
  await db
    .update(users)
    .set({ status: "active", disabledAt: null })
    .where(eq(users.email, email));
  expect((await app.request(me, { headers })).status).toBe(403);

  expect(JSON.stringify(await db.select().from(auditEvents))).not.toContain(
    secret,
  );
});
