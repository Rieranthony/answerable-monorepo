import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { createOrganizationDomain } from "../__tests__/domain-queries.ts";
import { createOrganization } from "../__tests__/organization-queries.ts";
import { createSsoProvider } from "../__tests__/sso-queries.ts";
import { testEnvironment } from "../__tests__/support.ts";
import { inTenantRead } from "../__tests__/tenant-command.ts";
import { retireUserEmail } from "../__tests__/user-queries.ts";
import type { Database } from "../db/client.ts";
import { createDatabase, type DatabaseConnection } from "../db/client.ts";
import { accounts, members, organizations, users } from "../db/schema/index.ts";
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
  const result = await diagnoseSignIn(db, org.id, email);
  verdict(result, "provider_not_found");
  expect(result.provider).toEqual({
    configured: false,
    kind: null,
    issuer: null,
  });
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
