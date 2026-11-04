import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { createOrganizationDomain } from "../__tests__/domain-queries.ts";
import { turnLinksOn } from "../__tests__/magic-link.ts";
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
import { magicLinkLimits } from "./magic-link-requests.ts";

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
async function seed(provider = true, account = provider) {
  const db = connection.db;
  const org = await createOrganization(db, { slug: "alpha", name: "Alpha" });
  await turnLinksOn(db, org.id);
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
  if (account)
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
    admission: "listed",
    suppressed: false,
    lastRequest: null,
    directoryConnection: null,
    requestsInLastDay: 0,
    dailyLimit: magicLinkLimits.addressPerDay,
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
      purpose: "link",
      tokenIdentifier: `magic-link:${id}`,
      browserHash: "browser",
      codeHmac: "code",
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
    admission: "listed",
    suppressed: true,
    directoryConnection: null,
    requestsInLastDay: 0,
    dailyLimit: magicLinkLimits.addressPerDay,
    lastRequest: {
      id,
      purpose: "link",
      sendStatus: "failed",
      postmarkErrorCode: 406,
      postmarkHttpStatus: 422,
      createdAt: expect.any(String),
    },
  });
  // Another address's row says nothing about this one, and the firm does not list it.
  const other = await diagnoseSignIn(db, org.id, "other@example.com");
  expect(other.magicLink.lastRequest).toBeNull();
  verdict(other, "magic_link_not_listed");

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
  const result = await diagnoseSignIn(db, org.id, email);
  expect(result.verdict.code).toBe("membership_revoked");
});
test("whether a directory's sign-in meets a held address depends on its token, so it is left to the token", () => {
  expect(tokenOnlyCodes).toContain("email_conflict");
});

test("where a link is the only way in, a person the firm does not list is told apart from one it does", async () => {
  const { db, org, memberId } = await seed(false);
  verdict(await diagnoseSignIn(db, org.id, email), "authentication_required");
  verdict(
    await diagnoseSignIn(db, org.id, "nobody@example.com"),
    "magic_link_not_listed",
  );
  // A membership whose window has closed is not an effective one.
  await db
    .update(members)
    .set({ validUntil: new Date(Date.now() - 1_000) })
    .where(eq(members.id, memberId));
  verdict(await diagnoseSignIn(db, org.id, email), "magic_link_not_listed");
});
test("it reads this firm's list alone: another firm's account is not its business, and in domain mode the verdict does not apply", async () => {
  const { db, org, userId } = await seed(false);
  await db.insert(accounts).values({
    id: createId(),
    userId,
    accountId: "subject",
    providerId: "another-firm",
    issuer,
  });
  verdict(await diagnoseSignIn(db, org.id, email), "authentication_required");
  await db
    .update(ssoProviders)
    .set({ admission: "domain" })
    .where(eq(ssoProviders.organizationId, org.id));
  verdict(
    await diagnoseSignIn(db, org.id, "nobody@example.com"),
    "authentication_required",
  );
});
test("with links off, or a directory beside them, a person the firm does not list is blocked by nothing here", async () => {
  const { db, org } = await seed(false);
  await db
    .update(ssoProviders)
    .set({ enabled: false })
    .where(eq(ssoProviders.organizationId, org.id));
  verdict(await diagnoseSignIn(db, org.id, email), "provider_not_found");
  await db
    .update(ssoProviders)
    .set({ enabled: true })
    .where(eq(ssoProviders.organizationId, org.id));
  await createSsoProvider(db, {
    organizationId: org.id,
    providerId: org.slug,
    issuer,
    domain: "example.com",
    oidc: { clientId: "client" },
  });
  verdict(
    await diagnoseSignIn(db, org.id, "nobody@example.com"),
    "authentication_required",
  );
});
test("an address at its day's limit is told apart where a link is the way in, counted as the limit counts: not what failed, nor what is older than a day", async () => {
  const { db, org } = await seed(false);
  const [row] = await db
    .select({ id: ssoProviders.id })
    .from(ssoProviders)
    .where(eq(ssoProviders.organizationId, org.id));
  const requests = (
    length: number,
    fields: Partial<typeof magicLinkRequests.$inferInsert> = {},
  ) =>
    db.insert(magicLinkRequests).values(
      Array.from({ length }, () => {
        const id = createId();
        return {
          id,
          organizationId: org.id,
          providerId: row!.id,
          providerRevision: 1,
          purpose: "link" as const,
          tokenIdentifier: `magic-link:${id}`,
          browserHash: "browser",
          codeHmac: "code",
          email,
          clientHash: "client",
          expiresAt: new Date(Date.now() + 60_000),
          ...fields,
        };
      }),
    );
  const limit = magicLinkLimits.addressPerDay;
  await requests(limit - 1);
  await requests(1, { sendStatus: "failed" });
  await requests(1, { createdAt: new Date(Date.now() - 25 * 3_600_000) });
  const below = await diagnoseSignIn(db, org.id, email);
  expect(below.magicLink).toMatchObject({
    requestsInLastDay: limit - 1,
    dailyLimit: limit,
  });
  verdict(below, "authentication_required");
  await requests(1);
  const reached = await diagnoseSignIn(db, org.id, email);
  expect(reached.magicLink.requestsInLastDay).toBe(limit);
  verdict(reached, "magic_link_address_limit");
  expect(
    (await diagnoseSignIn(db, org.id, "other@example.com")).magicLink
      .requestsInLastDay,
  ).toBe(0);
  // It precedes a suppression, and a directory sign-in reads neither.
  await requests(1, {
    sendStatus: "failed",
    postmarkErrorCode: 406,
    postmarkHttpStatus: 422,
    createdAt: new Date(Date.now() + 1_000),
  });
  verdict(await diagnoseSignIn(db, org.id, email), "magic_link_address_limit");
  await createSsoProvider(db, {
    organizationId: org.id,
    providerId: org.slug,
    issuer,
    domain: "example.com",
    oidc: { clientId: "client" },
  });
  verdict(await diagnoseSignIn(db, org.id, email), "authentication_required");
});
test("a code an address may be holding for a directory is shown, and only a live one", async () => {
  const { db, org } = await seed(false);
  const [row] = await db
    .select({ id: ssoProviders.id })
    .from(ssoProviders)
    .where(eq(ssoProviders.organizationId, org.id));
  const connection = {
    organizationId: org.id,
    providerId: row!.id,
    providerRevision: 1,
    purpose: "connect_directory" as const,
    email,
    clientHash: "client",
    browserHash: "browser",
    codeHmac: "hmac",
    directoryIssuer: issuer,
    directorySubject: "subject",
    directoryUserId: "subject",
    expiresAt: new Date(Date.now() + 60_000),
    sendStatus: "sent" as const,
  };
  const live = createId();
  const never = [
    { expiresAt: new Date(Date.now() - 1_000) },
    { sendStatus: "failed" as const },
    { attempts: 3 },
  ];
  for (const change of never) {
    await db
      .insert(magicLinkRequests)
      .values({ ...connection, ...change, id: createId() });
    expect(
      (await diagnoseSignIn(db, org.id, email)).magicLink.directoryConnection,
    ).toBeNull();
  }
  await db
    .insert(magicLinkRequests)
    .values({ ...connection, id: live, attempts: 1 });
  const shown = await diagnoseSignIn(db, org.id, email);
  expect(shown.magicLink.directoryConnection).toEqual({
    id: live,
    sendStatus: "sent",
    attempts: 1,
    expiresAt: expect.any(String),
  });
  // It is this address's and this firm's, and a link's request is not one.
  expect(
    (await diagnoseSignIn(db, org.id, "other@example.com")).magicLink
      .directoryConnection,
  ).toBeNull();
  const other = await createOrganization(db, { slug: "beta", name: "Beta" });
  expect(
    (await diagnoseSignIn(db, other.id, email)).magicLink.directoryConnection,
  ).toBeNull();
  await db.delete(magicLinkRequests).where(eq(magicLinkRequests.id, live));
  await db.insert(magicLinkRequests).values({
    id: createId(),
    organizationId: org.id,
    providerId: row!.id,
    providerRevision: 1,
    purpose: "link",
    tokenIdentifier: `magic-link:${createId()}`,
    browserHash: "browser",
    codeHmac: "code",
    email,
    clientHash: "client",
    expiresAt: new Date(Date.now() + 60_000),
    sendStatus: "sent",
  });
  expect(
    (await diagnoseSignIn(db, org.id, email)).magicLink.directoryConnection,
  ).toBeNull();
});

const diagnoseSignIn = (db: Database, org: string, email: string) =>
  inTenantRead(db, org, "memberAccess", (context) =>
    implementation(context, email),
  );
