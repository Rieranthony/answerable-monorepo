import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq, sql } from "drizzle-orm";

import { createApp, type App } from "../app.ts";
import { createAuth } from "../auth.ts";
import { signInThroughIdp } from "../__tests__/federation.ts";
import {
  startOidcIssuer,
  type OidcClaims,
  type OidcIssuer,
} from "../__tests__/oidc-issuer.ts";
import { isUuidV7, testEnvironment } from "../__tests__/support.ts";
import { createDatabase, type DatabaseConnection } from "../db/client.ts";
import { createOrganizationDomain } from "../db/queries/organization-domains.ts";
import { createSsoProvider } from "../db/queries/sso-providers.ts";
import {
  accounts,
  members,
  organizations,
  ssoProviders,
  users,
} from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";

const tenantId = "11111111-1111-4111-8111-111111111111";
const callbackURL = "https://chat.example.com/callback";
const errorCallbackURL = "https://chat.example.com/error";
const entraIssuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;

let issuer: OidcIssuer;
let connection: DatabaseConnection;
let app: App;

beforeAll(async () => {
  issuer = await startOidcIssuer();
  const environment = testEnvironment({
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
  await connection.db.execute(sql`
    truncate table
      sso_providers,
      organization_domains,
      members,
      sessions,
      accounts,
      verifications,
      organizations,
      users
    cascade
  `);
});

afterAll(async () => {
  issuer.stop();
  await connection.close();
});

async function seedProvider({
  slug = "contoso",
  domain = "contoso.com",
  providerIssuer = entraIssuer,
  endpoints = true,
}: {
  slug?: string;
  domain?: string;
  providerIssuer?: string;
  endpoints?: boolean;
} = {}) {
  const [organization] = await connection.db
    .insert(organizations)
    .values({ id: createId(), name: slug, slug })
    .returning();
  await createOrganizationDomain(connection.db, {
    organizationId: organization!.id,
    domain,
  });
  await createSsoProvider(connection.db, {
    organizationId: organization!.id,
    providerId: slug,
    issuer: providerIssuer,
    domain,
    oidc: {
      clientId: `${slug}-client`,
      clientSecret: "secret",
      ...(endpoints
        ? {
            authorizationEndpoint: `${issuer.origin}/authorize`,
            tokenEndpoint: `${issuer.origin}/token`,
            jwksEndpoint: `${issuer.origin}/jwks`,
          }
        : {}),
    },
  });
  return organization!;
}

function entraClaims(overrides: Partial<OidcClaims> = {}): OidcClaims {
  return {
    sub: "entra-subject",
    oid: "entra-object",
    tid: tenantId,
    email: "person@contoso.com",
    name: "Federated Person",
    iss: entraIssuer,
    ...overrides,
  };
}

async function signIn(providerId = "contoso") {
  return signInThroughIdp(app, {
    providerId,
    callbackURL,
    errorCallbackURL,
  });
}

function errorCode(location: string | null): string | null {
  return location ? new URL(location).searchParams.get("error") : null;
}

async function insertUser(
  email: string,
  status: "inert" | "active" | "disabled",
) {
  const id = createId();
  const [user] = await connection.db
    .insert(users)
    .values({
      id,
      name: "Existing Person",
      email,
      status,
      disabledAt: status === "disabled" ? new Date() : null,
    })
    .returning();
  return user!;
}

describe("integration: federated sign-in", () => {
  test("accepts the provider's organization and provisions one member", async () => {
    const organization = await seedProvider();
    issuer.enqueue(entraClaims());

    const result = await signIn();
    const [user] = await connection.db.select().from(users);
    const allAccounts = await connection.db.select().from(accounts);
    const [account] = allAccounts;
    const memberships = await connection.db.select().from(members);

    expect(result.location).toBe(callbackURL);
    expect(result.cookies.length).toBeGreaterThan(0);
    expect(user).toMatchObject({
      email: "person@contoso.com",
      emailVerified: true,
      status: "active",
    });
    expect(isUuidV7(user!.id)).toBe(true);
    expect(account).toMatchObject({
      userId: user!.id,
      issuer: entraIssuer,
      accountId: "entra-subject",
      directoryId: tenantId,
      directoryUserId: "entra-object",
    });
    expect(isUuidV7(account!.id)).toBe(true);
    expect(allAccounts).toHaveLength(1);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({
      organizationId: organization.id,
      userId: user!.id,
      role: "member",
    });
  });

  test("rejects a token from a foreign issuer before user resolution", async () => {
    await seedProvider();
    issuer.enqueue(entraClaims({ iss: "https://foreign.example.com" }));

    const result = await signIn();
    expect(errorCode(result.location)).toBe("invalid_provider");
    expect(new URL(result.location!).searchParams.get("error_description")).toBe(
      "token_not_verified",
    );
    expect(await connection.db.select().from(users)).toHaveLength(0);
  });

  test.each([
    ["directory_mismatch", { tid: "foreign-tenant" }],
    ["guest_account", { idp: "https://guest.example.com" }],
    ["guest_account", { acct: 1 }],
  ] as const)("rejects Entra claim policy: %s", async (code, claims) => {
    await seedProvider();
    issuer.enqueue(entraClaims(claims));

    const result = await signIn();
    expect(errorCode(result.location)).toBe(code);
    expect(await connection.db.select().from(users)).toHaveLength(0);
  });

  test.each([
    ["personal_account", { email_verified: true }],
    [
      "hosted_domain_mismatch",
      { hd: "other.example", email_verified: true },
    ],
    ["email_unverified", { hd: "contoso.com", email_verified: false }],
  ] as const)("rejects Google claim policy: %s", async (code, claims) => {
    await seedProvider({ providerIssuer: "https://accounts.google.com" });
    issuer.enqueue({
      sub: "google-subject",
      email: "person@contoso.com",
      name: "Google Person",
      iss: "https://accounts.google.com",
      ...claims,
    });

    const result = await signIn();
    expect(errorCode(result.location)).toBe(code);
    expect(await connection.db.select().from(users)).toHaveLength(0);
  });

  test("rejects an email outside the organization's active domains", async () => {
    await seedProvider();
    issuer.enqueue(entraClaims({ email: "person@other.example" }));

    expect(errorCode((await signIn()).location)).toBe("domain_not_allowed");
    expect(await connection.db.select().from(users)).toHaveLength(0);
  });

  test("does not borrow another organization's active domain", async () => {
    await seedProvider({ domain: "first.example.com" });
    const [other] = await connection.db
      .insert(organizations)
      .values({ id: createId(), name: "Other", slug: "other" })
      .returning();
    await createOrganizationDomain(connection.db, {
      organizationId: other!.id,
      domain: "contoso.com",
    });
    issuer.enqueue(entraClaims());

    expect(errorCode((await signIn()).location)).toBe("domain_not_allowed");
  });

  test("binds an inert import by immutable directory identity", async () => {
    const user = await insertUser("person@contoso.com", "inert");
    await seedProvider();
    await connection.db.insert(accounts).values({
      id: createId(),
      issuer: entraIssuer,
      accountId: "import:entra-object",
      providerId: "contoso",
      userId: user.id,
      directoryId: tenantId,
      directoryUserId: "entra-object",
    });
    issuer.enqueue(entraClaims());

    expect((await signIn()).location).toBe(callbackURL);
    const [updatedUser] = await connection.db
      .select()
      .from(users)
      .where(eq(users.id, user.id));
    const boundAccounts = await connection.db.select().from(accounts);
    expect(updatedUser).toMatchObject({ status: "active", emailVerified: true });
    expect(boundAccounts).toHaveLength(1);
    expect(boundAccounts[0]!.accountId).toBe("entra-subject");
  });

  test("releases a disabled holder's recycled email for a new identity", async () => {
    const oldUser = await insertUser("person@contoso.com", "disabled");
    await seedProvider();
    issuer.enqueue(entraClaims());

    expect((await signIn()).location).toBe(callbackURL);
    const allUsers = await connection.db.select().from(users);
    const retired = allUsers.find((user) => user.id === oldUser.id)!;
    const replacement = allUsers.find((user) => user.id !== oldUser.id)!;
    expect(retired).toMatchObject({
      email: `${oldUser.id}@retired.invalid`,
      retiredEmail: "person@contoso.com",
      status: "disabled",
    });
    expect(replacement).toMatchObject({
      email: "person@contoso.com",
      status: "active",
    });
  });

  test.each(["active", "inert"] as const)(
    "rejects a recycled email held by an %s user without changing it",
    async (status) => {
      const holder = await insertUser("person@contoso.com", status);
      await seedProvider();
      issuer.enqueue(entraClaims());

      expect(errorCode((await signIn()).location)).toBe("email_conflict");
      expect(await connection.db.select().from(users)).toEqual([holder]);
      expect(await connection.db.select().from(accounts)).toHaveLength(0);
    },
  );

  test("rejects a disabled user already bound to the exact account", async () => {
    const user = await insertUser("person@contoso.com", "disabled");
    await seedProvider();
    await connection.db.insert(accounts).values({
      id: createId(),
      issuer: entraIssuer,
      accountId: "entra-subject",
      providerId: "contoso",
      userId: user.id,
    });
    issuer.enqueue(entraClaims());

    expect(errorCode((await signIn()).location)).toBe("user_disabled");
  });

  test("refuses Better Auth's email-linking path", async () => {
    const user = await insertUser("person@contoso.com", "active");
    await seedProvider();
    await connection.db.insert(accounts).values({
      id: createId(),
      issuer: entraIssuer,
      accountId: "different-subject",
      providerId: "contoso",
      userId: user.id,
    });
    issuer.enqueue(entraClaims());

    expect(errorCode((await signIn()).location)).toBe("email_conflict");
    expect(await connection.db.select().from(accounts)).toHaveLength(1);
  });

  test("uses runtime discovery when endpoint fields are absent", async () => {
    await seedProvider({ providerIssuer: issuer.origin, endpoints: false });
    issuer.enqueue({
      sub: "runtime-subject",
      email: "person@contoso.com",
      email_verified: true,
      name: "Runtime Person",
    });

    expect((await signIn()).location).toBe(callbackURL);
    expect(await connection.db.select().from(users)).toHaveLength(1);
  });

  test("turns a thrown resolver error into an error redirect atomically", async () => {
    await seedProvider();
    issuer.enqueue(entraClaims({ email: "malformed" }));

    const result = await signIn();
    expect(errorCode(result.location)).toBe("SSO_USER_RESOLUTION_FAILED");
    expect(await connection.db.select().from(users)).toHaveLength(0);
    expect(await connection.db.select().from(accounts)).toHaveLength(0);
  });

  test("fills empty directory columns when the exact account is active", async () => {
    const user = await insertUser("person@contoso.com", "active");
    await seedProvider();
    await connection.db.insert(accounts).values({
      id: createId(),
      issuer: entraIssuer,
      accountId: "entra-subject",
      providerId: "contoso",
      userId: user.id,
    });
    issuer.enqueue(entraClaims());

    expect((await signIn()).location).toBe(callbackURL);
    const [account] = await connection.db.select().from(accounts);
    expect(account).toMatchObject({
      directoryId: tenantId,
      directoryUserId: "entra-object",
    });
  });

  test("reactivates an inert user already bound to the exact account", async () => {
    const user = await insertUser("person@contoso.com", "inert");
    await seedProvider();
    await connection.db.insert(accounts).values({
      id: createId(),
      issuer: entraIssuer,
      accountId: "entra-subject",
      providerId: "contoso",
      userId: user.id,
    });
    issuer.enqueue(entraClaims());

    expect((await signIn()).location).toBe(callbackURL);
    const [active] = await connection.db.select().from(users);
    expect(active).toMatchObject({ status: "active", emailVerified: true });
  });

  test("keeps provider selection stable by organization slug", async () => {
    await seedProvider();
    issuer.enqueue(entraClaims());

    const result = await signInThroughIdp(app, {
      organizationSlug: "contoso",
      callbackURL,
      errorCallbackURL,
    });
    expect(result.location).toBe(callbackURL);
    expect(await connection.db.select().from(ssoProviders)).toHaveLength(1);
  });
});
