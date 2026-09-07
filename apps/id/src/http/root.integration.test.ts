import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { createApp } from "../app.ts";
import { createAuth } from "../auth.ts";
import { addStaff, bootstrap } from "../bootstrap.ts";
import { createDatabase, type DatabaseConnection } from "../db/client.ts";
import { auditEvents } from "../db/schema/index.ts";
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
    sql`truncate table audit_events, entitlements, group_members, groups,
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
    rootAdminSecret: secret,
    rootAdminBreakGlass: false,
    trustedOrigins: [issuer.origin, "https://console.example.com"],
  });
  const auth = createAuth(db, environment);
  const app = createApp({ db, auth, environment });
  const headers = {
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
    ip: "192.0.2.1",
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
  await bootstrap(db, {
    platformOrganizationSlug: environment.platformOrganizationSlug,
    platformOrganizationName: "Answerable",
    platformDomain: "answerable.example.com",
    sso: {
      issuer: issuer.origin,
      clientId: "platform-sso",
      clientSecret: "secret",
    },
    adminResourceIdentifier: environment.adminResourceIdentifier,
    bootstrapClientId: "answerable-bootstrap",
  });
  expect((await app.request(me, { headers })).status).toBe(200);
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
  await addStaff(db, {
    platformOrganizationSlug: environment.platformOrganizationSlug,
    email,
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
  expect(JSON.stringify(await db.select().from(auditEvents))).not.toContain(
    secret,
  );
});
