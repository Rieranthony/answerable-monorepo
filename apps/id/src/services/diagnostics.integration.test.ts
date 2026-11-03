import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { createOrganizationDomain } from "../__tests__/domain-queries.ts";
import { createOrganization } from "../__tests__/organization-queries.ts";
import { createSsoProvider } from "../__tests__/sso-queries.ts";
import { testEnvironment } from "../__tests__/support.ts";
import { inTenantRead } from "../__tests__/tenant-command.ts";
import { retireUserEmail } from "../__tests__/user-queries.ts";
import {
  type Database,
  createDatabase,
  type DatabaseConnection,
} from "../db/client.ts";
import {
  accounts,
  magicLinkRequests,
  members,
  organizations,
  ssoProviders,
  users,
} from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";
import {
  diagnoseSignIn as implementation,
  signInVerdictCodes,
  tokenOnlyCodes,
} from "./diagnostics.ts";

let connection: DatabaseConnection;
beforeAll(() => {
  connection = createDatabase(testEnvironment());
});
beforeEach(async () => {
  await connection.db.execute(
    sql`truncate table audit_events, organizations, users cascade`,
  );
});
afterAll(async () => {
  await connection.close();
});
const issuer = "https://id.example.com";
const email = "person@example.com";
async function seed(provider = true) {
  const db = connection.db;
  const org = await createOrganization(db, { slug: "alpha", name: "Alpha" });
  await createOrganizationDomain(db, {
    organizationId: org.id,
    domain: "example.com",
  });
  if (provider)
    await createSsoProvider(db, {
      organizationId: org.id,
      providerId: org.slug,
      issuer,
      domain: "example.com",
      oidc: { clientId: "client" },
    });
  const userId = createId();
  const memberId = createId();
  await db
    .insert(users)
    .values({ id: userId, name: "Person", email, status: "active" });
  await db.insert(accounts).values({
    id: createId(),
    userId,
    accountId: "subject",
    providerId: org.slug,
    issuer,
  });
  await db
    .insert(members)
    .values({ id: memberId, userId, organizationId: org.id });
  return { db, org, userId, memberId };
}
function verdict(
  result: Awaited<ReturnType<typeof diagnoseSignIn>>,
  code: (typeof signInVerdictCodes)[number],
) {
  expect(result.verdict).toEqual({
    code,
    checked: signInVerdictCodes.slice(0, signInVerdictCodes.indexOf(code) + 1),
    requiresToken: [...tokenOnlyCodes],
  });
}
test("provider precedes disabled organisation and routing", async () => {
  const { db, org } = await seed(false);
  await db
    .update(organizations)
    .set({ status: "disabled", disabledAt: new Date() })
    .where(eq(organizations.id, org.id));
  await db
    .update(ssoProviders)
    .set({ enabled: false })
    .where(eq(ssoProviders.organizationId, org.id));
  const result = await diagnoseSignIn(db, org.id, email);
  verdict(result, "provider_not_found");
  expect(result.provider).toEqual({
    configured: false,
    kind: null,
    issuer: null,
  });
});
test("a firm with no directory and links on is not a missing provider", async () => {
  const { db, org } = await seed(false);
  const result = await diagnoseSignIn(db, org.id, email);
  verdict(result, "authentication_required");
  expect(result.provider.configured).toBe(false);
  expect(result.magicLink).toEqual({
    enabled: true,
    suppressed: false,
    lastRequest: null,
  });
});
test("a suppressed address blocks only where a link is the way in, and is shown", async () => {
  const { db, org } = await seed(false);
  const [row] = await db
    .select({ id: ssoProviders.id })
    .from(ssoProviders)
    .where(eq(ssoProviders.organizationId, org.id));
  const write = async (values: {
    postmarkErrorCode: number | null;
    postmarkHttpStatus: number | null;
  }) => {
    const id = createId();
    await db.insert(magicLinkRequests).values({
      id,
      organizationId: org.id,
      providerId: row!.id,
      providerRevision: 1,
      purpose: "access_removed",
      email,
      clientHash: "client",
      expiresAt: new Date(Date.now() + 60_000),
      sendStatus: "failed",
      ...values,
    });
    return id;
  };
  await write({ postmarkErrorCode: 300, postmarkHttpStatus: 422 });
  verdict(await diagnoseSignIn(db, org.id, email), "authentication_required");

  const id = await write({ postmarkErrorCode: 406, postmarkHttpStatus: 422 });
  const suppressed = await diagnoseSignIn(db, org.id, email);
  verdict(suppressed, "magic_link_suppressed");
  expect(suppressed.magicLink).toEqual({
    enabled: true,
    suppressed: true,
    lastRequest: {
      id,
      purpose: "access_removed",
      sendStatus: "failed",
      postmarkErrorCode: 406,
      postmarkHttpStatus: 422,
      createdAt: expect.any(String),
    },
  });
  // Another address's row says nothing about this one.
  const other = await diagnoseSignIn(db, org.id, "other@example.com");
  expect(other.magicLink.lastRequest).toBeNull();
  verdict(other, "authentication_required");

  await createSsoProvider(db, {
    organizationId: org.id,
    providerId: org.slug,
    issuer,
    domain: "example.com",
    oidc: { clientId: "client" },
  });
  const withDirectory = await diagnoseSignIn(db, org.id, email);
  verdict(withDirectory, "authentication_required");
  expect(withDirectory.magicLink.suppressed).toBe(true);
});
test("a firm with a directory shows its magic-link setting beside it", async () => {
  const { db, org } = await seed();
  await db
    .update(ssoProviders)
    .set({ enabled: false })
    .where(
      and(
        eq(ssoProviders.organizationId, org.id),
        eq(ssoProviders.kind, "magic_link"),
      ),
    );
  const result = await diagnoseSignIn(db, org.id, email);
  expect(result.provider.configured).toBe(true);
  expect(result.magicLink.enabled).toBe(false);
  verdict(result, "authentication_required");
});
test("the setting shown is this firm's magic-link row, whichever rows exist", async () => {
  const db = connection.db;
  const other = await createOrganization(db, { slug: "other", name: "Other" });
  await db
    .update(ssoProviders)
    .set({ enabled: false })
    .where(eq(ssoProviders.organizationId, other.id));
  const { org } = await seed();
  const shown = await diagnoseSignIn(db, org.id, email);
  expect(shown.magicLink.enabled).toBe(true);
  const theirs = await diagnoseSignIn(db, other.id, email);
  expect(theirs.magicLink.enabled).toBe(false);
  // A directory beside it is not the setting: with no magic-link row, there is none.
  await db
    .update(ssoProviders)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(ssoProviders.organizationId, org.id),
        eq(ssoProviders.kind, "magic_link"),
      ),
    );
  const gone = await diagnoseSignIn(db, org.id, email);
  expect(gone.provider.configured).toBe(true);
  expect(gone.magicLink.enabled).toBe(false);
});
test("disabled organisation precedes domain rejection", async () => {
  const { db, org } = await seed();
  await db
    .update(organizations)
    .set({ status: "disabled", disabledAt: new Date() })
    .where(eq(organizations.id, org.id));
  verdict(await diagnoseSignIn(db, org.id, email), "organization_disabled");
});
test("reports unrouted domains and domains routed elsewhere", async () => {
  const { db, org } = await seed();
  const other = await createOrganization(db, { slug: "beta", name: "Beta" });
  const elsewhere = await diagnoseSignIn(db, other.id, email);
  expect(elsewhere.routing).toEqual({
    domain: "example.com",
    routesTo: null,
    matchesThisOrganization: false,
  });
  await createSsoProvider(db, {
    organizationId: other.id,
    providerId: other.slug,
    issuer,
    domain: "other.example",
    oidc: { clientId: "client" },
  });
  verdict(await diagnoseSignIn(db, other.id, email), "domain_not_allowed");
  const unrouted = await diagnoseSignIn(db, org.id, "person@unrouted.example");
  verdict(unrouted, "domain_not_allowed");
  expect(unrouted.routing.routesTo).toBeNull();
});
test("retirement details are omitted; only exact local membership emails match", async () => {
  const { db, org, userId } = await seed();
  await db
    .update(users)
    .set({ status: "disabled", disabledAt: new Date() })
    .where(eq(users.id, userId));
  const retired = await retireUserEmail(db, userId);
  verdict(await diagnoseSignIn(db, org.id, email), "authentication_required");
  const result = await diagnoseSignIn(db, org.id, retired.email);
  expect(result.user).toEqual({
    id: userId,
    status: "disabled",
  });
  verdict(result, "domain_not_allowed");
});
test("diagnosis reports revoked admission rather than a successful sign-in", async () => {
  const { db, org, memberId } = await seed();
  await db
    .update(members)
    .set({ status: "revoked", revokedAt: new Date() })
    .where(eq(members.id, memberId));
  expect((await diagnoseSignIn(db, org.id, email)).verdict.code).toBe(
    "membership_revoked",
  );
});

const diagnoseSignIn = (db: Database, org: string, email: string) =>
  inTenantRead(db, org, "memberAccess", (context) =>
    implementation(context, email),
  );
