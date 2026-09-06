import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { createApp, type App } from "../../app.ts";
import { createAuth } from "../../auth.ts";
import { signInThroughIdp } from "../../__tests__/federation.ts";
import {
  startOidcIssuer,
  type OidcIssuer,
} from "../../__tests__/oidc-issuer.ts";
import { testEnvironment } from "../../__tests__/support.ts";
import { createDatabase, type DatabaseConnection } from "../../db/client.ts";
import { createOrganizationDomain } from "../../db/queries/organization-domains.ts";
import { createSsoProvider } from "../../db/queries/sso-providers.ts";
import {
  auditEvents,
  entitlements,
  groupMembers,
  groups,
  members,
  oauthResources,
  organizations,
} from "../../db/schema/index.ts";
import { createId } from "../../lib/id.ts";
import { meSchema } from "./me.ts";

let issuer: OidcIssuer;
let connection: DatabaseConnection;
let app: App;
const callbackURL = "https://admin.example.com/callback";
let environment: ReturnType<typeof testEnvironment>;

beforeAll(async () => {
  issuer = await startOidcIssuer();
  environment = testEnvironment({
    trustedOrigins: [issuer.origin, new URL(callbackURL).origin],
  });
  connection = createDatabase(environment);
  app = createApp({
    auth: createAuth(connection.db, environment),
    db: connection.db,
    environment,
  });
});
beforeEach(async () => {
  await connection.db.execute(
    sql`truncate table users, organizations, oauth_resources, audit_events cascade`,
  );
  await connection.db.insert(oauthResources).values({
    id: createId(),
    identifier: environment.adminResourceIdentifier,
    name: "Admin API",
  });
});
afterAll(async () => {
  issuer.stop();
  await connection.close();
});

async function signIn(slug: string) {
  const organizationId = createId();
  const domain = `${slug}.example.com`;
  await connection.db
    .insert(organizations)
    .values({ id: organizationId, slug, name: slug });
  await createOrganizationDomain(connection.db, { organizationId, domain });
  await createSsoProvider(connection.db, {
    organizationId,
    providerId: slug,
    issuer: issuer.origin,
    domain,
    oidc: {
      clientId: `${slug}-client`,
      clientSecret: "secret",
      authorizationEndpoint: `${issuer.origin}/authorize`,
      tokenEndpoint: `${issuer.origin}/token`,
      jwksEndpoint: `${issuer.origin}/jwks`,
    },
  });
  const email = `person@${domain}`;
  issuer.enqueue({
    sub: `${slug}-subject`,
    email,
    email_verified: true,
    name: "Admin member",
  });
  const result = await signInThroughIdp(app, { providerId: slug, callbackURL });
  expect(result.location).toBe(callbackURL);
  expect(result.cookies.length).toBeGreaterThan(0);
  const cookie = result.cookies
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  const [member] = await connection.db
    .select()
    .from(members)
    .where(eq(members.organizationId, organizationId));
  expect(member).toBeDefined();
  return { cookie, organizationId, member: member!, email };
}

test("integration: me requires a grant, then exposes a federated platform administrator", async () => {
  const { cookie, organizationId, member, email } = await signIn(
    environment.platformOrganizationSlug,
  );
  const request = () =>
    app.request("/api/admin/v1/me", { headers: { Cookie: cookie } });
  const denied = await request();
  expect(denied.status).toBe(403);
  expect(await denied.json()).toMatchObject({ code: "insufficient_scope" });
  const deniedEvents = await connection.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.action, "admin.denied"));
  expect(deniedEvents).toHaveLength(1);
  expect(deniedEvents[0]).toMatchObject({
    actorId: member.userId,
    actorType: "user",
    outcome: "denied",
    targetId: "getAdminMe",
  });

  const groupId = createId();
  await connection.db.insert(groups).values({
    id: groupId,
    organizationId,
    slug: "platform-admins",
    name: "Platform administrators",
  });
  await connection.db
    .insert(groupMembers)
    .values({ organizationId, groupId, memberId: member.id });
  const scopes = ["platform:read", "platform:users", "platform:write"];
  await connection.db.insert(entitlements).values({
    id: createId(),
    organizationId,
    groupId,
    resource: environment.adminResourceIdentifier,
    scopes,
  });
  const response = await request();
  expect(response.status).toBe(200);
  expect(meSchema.parse(await response.json())).toEqual({
    principal: {
      type: "user",
      userId: member.userId,
      email,
      sessionId: expect.any(String),
    },
    grants: [
      {
        organizationId,
        organizationSlug: environment.platformOrganizationSlug,
        scopes,
      },
    ],
  });
  const anonymous = await app.request("/api/admin/v1/me");
  expect(anonymous.status).toBe(401);
  expect(await anonymous.json()).toMatchObject({ code: "unauthenticated" });

  const tenant = await signIn("tenant");
  await connection.db.insert(entitlements).values({
    id: createId(),
    organizationId: tenant.organizationId,
    memberId: tenant.member.id,
    resource: environment.adminResourceIdentifier,
    scopes: ["org:read"],
  });
  const tenantResponse = await app.request("/api/admin/v1/me", {
    headers: { Cookie: tenant.cookie },
  });
  expect(tenantResponse.status).toBe(200);
  expect(meSchema.parse(await tenantResponse.json())).toEqual({
    principal: {
      type: "user",
      userId: tenant.member.userId,
      email: tenant.email,
      sessionId: expect.any(String),
    },
    grants: [
      {
        organizationId: tenant.organizationId,
        organizationSlug: "tenant",
        scopes: ["org:read"],
      },
    ],
  });
});
