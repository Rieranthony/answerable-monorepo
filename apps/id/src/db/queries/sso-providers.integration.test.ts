import {
  afterAll,
  beforeAll,
  beforeEach,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import { sql } from "drizzle-orm";
import { testEnvironment } from "../../__tests__/support.ts";
import { createDatabase, type DatabaseConnection } from "../client.ts";
import { createOrganization } from "../../__tests__/organization-queries.ts";
import { createId } from "../../lib/id.ts";
let connection: DatabaseConnection;
beforeAll(() => {
  connection = createDatabase(testEnvironment());
});
beforeEach(async () => {
  await connection.db.execute(
    sql`truncate table security_identifiers, audit_events, organizations, users cascade`,
  );
});
afterAll(async () => {
  await connection.close();
});
import * as queries from "../../__tests__/sso-queries.ts";
import * as productionQueries from "./sso-providers.ts";
test("provider queries create, find, update, redact and delete", async () => {
  const db = connection.db;
  const org = await createOrganization(db, { slug: "alpha", name: "Alpha" });
  expect(await queries.findSsoProviderByOrganization(db, org.id)).toBeNull();
  expect(await queries.deleteSsoProvider(db, createId())).toBeNull();
  const input = {
    organizationId: org.id,
    providerId: org.slug,
    issuer: "https://login.example.com",
    domain: " ACME.EXAMPLE.COM ",
    oidc: { clientId: "client", clientSecret: "private-secret" },
  };
  const row = await queries.createSsoProvider(db, input);
  expect(row.domain).toBe("acme.example.com");
  expect(await queries.findSsoProviderByOrganization(db, org.id)).toEqual(row);
  const redacted = queries.redactSsoProvider(row);
  expect(redacted.oidc).toMatchObject({
    clientId: "client",
    hasClientSecret: true,
    pkce: true,
    tokenEndpointAuthentication: "client_secret_post",
    discoveryEndpoint: input.issuer + "/.well-known/openid-configuration",
  });
  expect(JSON.stringify(redacted)).not.toContain("private-secret");
  expect(JSON.stringify(redacted)).not.toContain('"clientSecret"');
  expect(redacted).not.toHaveProperty("oidcConfig");
  const oidc = {
    clientId: "replacement",
    tokenEndpointAuthentication: "client_secret_basic" as const,
    discoveryEndpoint: "https://login.example.com/discovery",
    authorizationEndpoint: "https://login.example.com/authorize",
    tokenEndpoint: "https://login.example.com/token",
    jwksEndpoint: "https://login.example.com/jwks",
    scopes: ["openid"],
    pkce: false,
  };
  const updated = await queries.updateSsoProvider(db, row.id, {
    ...input,
    oidc,
  });
  expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(
    row.updatedAt.getTime(),
  );
  expect(queries.redactSsoProvider(updated).oidc).toEqual({
    ...oidc,
    hasClientSecret: false,
  });
  expect(
    queries.redactSsoProvider({ ...row, oidcConfig: null }).oidc
      .hasClientSecret,
  ).toBe(false);
  expect(await queries.deleteSsoProvider(db, org.id)).toMatchObject({
    id: updated.id,
    revision: updated.revision + 1,
    deletedAt: expect.any(Date),
    oidcConfig: null,
    samlConfig: null,
  });
  expect(await queries.deleteSsoProvider(db, org.id)).toBeNull();
  expect(await queries.findSsoProviderByOrganization(db, org.id)).toBeNull();
});

test("provider update timestamps use the database clock despite application clock skew", async () => {
  const db = connection.db;
  const org = await createOrganization(db, {
    slug: "clock-proof",
    name: "Clock proof",
  });
  const input = {
    organizationId: org.id,
    providerId: org.slug,
    issuer: "https://login.example.com",
    domain: "clock.example.com",
    oidc: { clientId: "clock-client" },
  };
  const row = await queries.createSsoProvider(db, input);
  let updated: Awaited<ReturnType<typeof queries.updateSsoProvider>>;
  try {
    setSystemTime(new Date("2000-01-01T00:00:00Z"));
    updated = await queries.updateSsoProvider(db, row.id, {
      ...input,
      domain: "changed.example.com",
    });
  } finally {
    setSystemTime();
  }
  expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(
    row.updatedAt.getTime(),
  );
  expect(updated!.domain).toBe("changed.example.com");
});

test("SSO configuration query rejects a raw database handle", async () => {
  await expect(
    Promise.resolve().then(() =>
      Reflect.apply(productionQueries.findSsoProviderForCommand, undefined, [
        connection.db,
        createId(),
      ]),
    ),
  ).rejects.toThrow("Invalid or expired");
});

test("SSO query purposes, provenance and lifetime cannot be widened", async () => {
  const { inPlatformRead, inPlatformWrite } =
    await import("../../__tests__/platform-context.ts");
  const { inTenantRead } = await import("../../__tests__/tenant-command.ts");
  const org = await createOrganization(connection.db, {
    slug: "contexts",
    name: "Contexts",
  });
  const input = {
    organizationId: org.id,
    providerId: org.slug,
    issuer: "https://idp.example",
    domain: "example.com",
    oidc: { clientId: "id", clientSecret: "not-for-readers" },
  };
  const writes = [
    [productionQueries.createSsoProvider, [input]],
    [productionQueries.findSsoProviderForCommand, [org.id]],
    [productionQueries.updateSsoProvider, [createId(), input]],
    [productionQueries.deleteSsoProvider, [org.id]],
  ] as const;
  const directory = [[productionQueries.readSsoProvider, []]] as const;
  const diagnosis = [[productionQueries.readSsoIssuer, []]] as const;
  const platform = [[productionQueries.readSsoEndpoints, [org.id]]] as const;
  const all = [...writes, ...directory, ...diagnosis, ...platform];
  async function reject(context: unknown, cases: Readonly<typeof all>) {
    for (const [fn, args] of cases)
      await expect(
        Promise.resolve().then(() =>
          Reflect.apply(fn, undefined, [context, ...args]),
        ),
      ).rejects.toThrow("Invalid or expired");
  }
  await reject(connection.db, all);
  let expired: unknown;
  await inPlatformWrite(connection.db, async (context) => {
    expired = context;
    await reject({ ...context }, all);
    await reject(context, [...directory, ...diagnosis, ...platform]);
  });
  await reject(expired, all);
  await inPlatformRead(connection.db, async (context) => {
    expired = context;
    await reject({ ...context }, all);
    await reject(context, [...writes, ...directory, ...diagnosis]);
    expect(
      await productionQueries.readSsoEndpoints(context, org.id),
    ).toBeNull();
  });
  await reject(expired, all);
  for (const access of [
    "directory",
    "memberAccess",
    "history",
    "configuration",
  ] as const) {
    await inTenantRead(connection.db, org.id, access, async (context) => {
      expired = context;
      await reject({ ...context }, all);
      await reject(context, [...writes, ...platform]);
      if (access !== "directory") await reject(context, directory);
      if (access !== "memberAccess") await reject(context, diagnosis);
    });
    await reject(expired, all);
  }
});

test("SSO read projections expose only their intended configuration", async () => {
  const { inPlatformRead } =
    await import("../../__tests__/platform-context.ts");
  const { inTenantRead } = await import("../../__tests__/tenant-command.ts");
  const { ssoProviders } = await import("../schema/index.ts");
  const { eq } = await import("drizzle-orm");
  const org = await createOrganization(connection.db, {
    slug: "projections",
    name: "Projections",
  });
  await inTenantRead(connection.db, org.id, "directory", async (context) =>
    expect(await productionQueries.readSsoProvider(context)).toBeNull(),
  );
  await inTenantRead(connection.db, org.id, "memberAccess", async (context) =>
    expect(await productionQueries.readSsoIssuer(context)).toBeNull(),
  );
  const row = await queries.createSsoProvider(connection.db, {
    organizationId: org.id,
    providerId: org.slug,
    issuer: "https://idp.example",
    domain: "example.com",
    oidc: {
      clientId: "id",
      clientSecret: "not-for-readers",
      discoveryEndpoint: "https://idp.example/discovery",
    },
  });
  await inTenantRead(connection.db, org.id, "directory", async (context) => {
    const result = await productionQueries.readSsoProvider(context);
    expect(result).toEqual(queries.redactSsoProvider(row));
    expect(JSON.stringify(result)).not.toContain("not-for-readers");
  });
  await inTenantRead(connection.db, org.id, "memberAccess", async (context) =>
    expect(await productionQueries.readSsoIssuer(context)).toEqual({
      issuer: row.issuer,
    }),
  );
  await inPlatformRead(connection.db, async (context) =>
    expect(await productionQueries.readSsoEndpoints(context, org.id)).toEqual({
      issuer: row.issuer,
      discoveryEndpoint: "https://idp.example/discovery",
    }),
  );
  await connection.db
    .update(ssoProviders)
    .set({ oidcConfig: null })
    .where(eq(ssoProviders.id, row.id));
  await inPlatformRead(connection.db, async (context) =>
    expect(await productionQueries.readSsoEndpoints(context, org.id)).toEqual({
      issuer: row.issuer,
      discoveryEndpoint: undefined,
    }),
  );
});
