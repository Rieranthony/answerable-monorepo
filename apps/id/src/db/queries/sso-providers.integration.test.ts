import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { testEnvironment } from "../../__tests__/support.ts";
import { createDatabase, type DatabaseConnection } from "../client.ts";
import { createOrganization } from "./organizations.ts";
import { createId } from "../../lib/id.ts";
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
import * as queries from "./sso-providers.ts";
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
  expect(await queries.deleteSsoProvider(db, org.id)).toEqual(updated);
  expect(await queries.deleteSsoProvider(db, org.id)).toBeNull();
  expect(await queries.findSsoProviderByOrganization(db, org.id)).toBeNull();
});
