import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { testEnvironment } from "../__tests__/support.ts";
import { createDatabase, type DatabaseConnection } from "../db/client.ts";
import { createOrganization } from "../db/queries/organizations.ts";
import { createOrganizationDomain } from "../db/queries/organization-domains.ts";
import { createSsoProvider } from "../db/queries/sso-providers.ts";
import { findUserByEmail, retireUserEmail } from "../db/queries/users.ts";
import { accounts, members, organizations, users } from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";
import {
  diagnoseSignIn,
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
test("missing organisation is 404", async () => {
  await expect(
    diagnoseSignIn(connection.db, createId(), email),
  ).rejects.toMatchObject({ status: 404, code: "not_found" });
});
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
    routesTo: { organizationId: org.id, slug: org.slug },
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
test("unknown email would create a user without mutating the database", async () => {
  const { db, org } = await seed();
  const result = await diagnoseSignIn(db, org.id, "unknown@example.com");
  verdict(result, "new_user_would_be_created");
  expect(result).toMatchObject({ user: null, accounts: [], membership: null });
  expect(await findUserByEmail(db, "unknown@example.com")).toBeNull();
});
test("disabled user is reported without retirement", async () => {
  const { db, org, userId } = await seed();
  await db
    .update(users)
    .set({ status: "disabled", disabledAt: new Date() })
    .where(eq(users.id, userId));
  const result = await diagnoseSignIn(db, org.id, email);
  verdict(result, "user_disabled");
  expect(result.user).toEqual({
    id: userId,
    status: "disabled",
    retiredEmail: false,
  });
  expect((await findUserByEmail(db, email))!.retiredEmail).toBeNull();
});
test("retired addresses are exact matches; old email is free", async () => {
  const { db, org, userId } = await seed();
  await db
    .update(users)
    .set({ status: "disabled", disabledAt: new Date() })
    .where(eq(users.id, userId));
  const retired = await retireUserEmail(db, userId);
  verdict(await diagnoseSignIn(db, org.id, email), "new_user_would_be_created");
  const result = await diagnoseSignIn(db, org.id, retired.email);
  expect(result.user).toEqual({
    id: userId,
    status: "disabled",
    retiredEmail: true,
  });
  verdict(result, "domain_not_allowed");
});
test("all conflicting issuers reject; one matching issuer permits sign-in", async () => {
  const { db, org, userId } = await seed();
  await db
    .update(accounts)
    .set({ issuer: "https://other.example.com", directoryId: "directory" })
    .where(eq(accounts.userId, userId));
  const result = await diagnoseSignIn(db, org.id, email);
  verdict(result, "identity_conflict");
  expect(result.accounts).toEqual([
    {
      issuer: "https://other.example.com",
      matchesProvider: false,
      directoryId: "directory",
    },
  ]);
  await db.insert(accounts).values({
    id: createId(),
    userId,
    accountId: "matching",
    providerId: org.slug,
    issuer,
  });
  verdict(await diagnoseSignIn(db, org.id, email), "would_sign_in");
});
test("effective and non-effective membership windows do not gate sign-in", async () => {
  const { db, org, userId, memberId } = await seed();
  const result = await diagnoseSignIn(db, org.id, email.toUpperCase());
  verdict(result, "would_sign_in");
  expect(result.email).toBe(email);
  expect(result.membership).toEqual({
    memberId,
    effective: true,
    validFrom: null,
    validUntil: null,
  });
  expect(result.provider).toEqual({ configured: true, kind: "oidc", issuer });
  expect(await findUserByEmail(db, email.toUpperCase())).toMatchObject({
    id: userId,
  });
  const past = new Date("2000-01-01T00:00:00Z");
  const future = new Date("2100-01-01T00:00:00Z");
  for (const window of [
    { validFrom: null, validUntil: past },
    { validFrom: future, validUntil: null },
  ]) {
    await db.update(members).set(window).where(eq(members.id, memberId));
    const diagnosis = await diagnoseSignIn(db, org.id, email);
    verdict(diagnosis, "would_sign_in");
    expect(diagnosis.membership).toEqual({
      memberId,
      effective: false,
      ...window,
    });
  }
  await db.delete(members).where(eq(members.id, memberId));
  await db.delete(accounts).where(eq(accounts.userId, userId));
  await db.update(users).set({ status: "inert" }).where(eq(users.id, userId));
  const noMembership = await diagnoseSignIn(db, org.id, email);
  verdict(noMembership, "would_sign_in");
  expect(noMembership.membership).toBeNull();
});
