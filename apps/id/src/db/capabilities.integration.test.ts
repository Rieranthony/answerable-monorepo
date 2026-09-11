import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { createDatabase, type DatabaseConnection } from "./client.ts";
import { testEnvironment } from "../__tests__/support.ts";
import { createId } from "../lib/id.ts";
import { bootstrap, systemActor } from "../bootstrap.ts";
import {
  organizationCapabilities as caps,
  organizations,
  oauthClients,
  oauthResources,
} from "./schema/index.ts";
let connection: DatabaseConnection;
let organizationId: string;
let foreignId: string;
let clientId: string;
let resource: string;
beforeAll(async () => {
  connection = createDatabase(testEnvironment());
  await connection.db.execute(
    sql`truncate organizations, oauth_clients, oauth_resources cascade`,
  );
  const seeded = await bootstrap(
    connection.db,
    systemActor("capability-schema"),
    {
      platformOrganizationSlug: "answerable",
      platformOrganizationName: "Answerable",
      adminResourceIdentifier: testEnvironment().adminResourceIdentifier,
    },
  );
  organizationId = createId();
  foreignId = seeded.organization.id;
  clientId = `machine-${createId()}`;
  resource = `https://${createId()}.example`;
  await connection.db
    .insert(organizations)
    .values({ id: organizationId, slug: "capability-owner", name: "Owner" });
  await connection.db.insert(oauthClients).values({
    id: createId(),
    clientId,
    name: "Machine",
    organizationId,
    redirectUris: [],
  });
  await connection.db.insert(oauthResources).values({
    id: createId(),
    identifier: resource,
    name: "Private",
    classification: "tenant_owned",
    organizationId,
  });
});
afterAll(async () => connection.close());
const input = () => ({
  id: createId(),
  organizationId,
  clientId,
  resource,
  grantKind: "client_credentials" as const,
  scopes: ["read"],
});

test("capability constraints enforce immutable exact targets, ownership, kinds, scope shape and windows", async () => {
  const [row] = await connection.db.insert(caps).values(input()).returning();
  await expect(
    connection.db.insert(caps).values(input()).execute(),
  ).rejects.toMatchObject({ cause: { code: "23505" } });
  for (const patch of [
    { id: createId() },
    { organizationId: foreignId },
    { clientId: "different" },
    { resource: "https://changed.example" },
    { grantKind: "authorization_code" as const },
  ])
    await expect(
      connection.db
        .update(caps)
        .set(patch)
        .where(eq(caps.id, row!.id))
        .execute(),
    ).rejects.toMatchObject({
      cause: { code: expect.stringMatching(/^235(03|14)$/) },
    });
  for (const patch of [
    { clientId: null },
    { resource: null },
    { scopes: [] },
    { scopes: [""] },
    { scopes: ["platform:write"] },
    { validFrom: new Date("2030-02-01"), validUntil: new Date("2030-01-01") },
  ])
    await expect(
      connection.db
        .insert(caps)
        .values({ ...input(), ...patch })
        .execute(),
    ).rejects.toMatchObject({
      cause: { code: expect.stringMatching(/^235(03|14)$/) },
    });
  await expect(
    connection.db
      .insert(caps)
      .values({ ...input(), organizationId: foreignId })
      .execute(),
  ).rejects.toMatchObject({ cause: { code: "23503" } });
  await expect(
    connection.db
      .insert(caps)
      .values({
        ...input(),
        organizationId: foreignId,
        grantKind: "authorization_code",
      })
      .execute(),
  ).rejects.toMatchObject({ cause: { code: "23503" } });
  // Exact grant-kind uniqueness keeps future user permission separate from machine authority.
  const [user] = await connection.db
    .insert(caps)
    .values({ ...input(), grantKind: "authorization_code" })
    .returning();
  expect(user!.id).not.toBe(row!.id);
  const [login] = await connection.db
    .insert(caps)
    .values({ ...input(), resource: null, grantKind: "authorization_code" })
    .returning();
  expect(login!.resource).toBeNull();
  await expect(
    connection.db
      .insert(caps)
      .values({ ...input(), clientId: null, grantKind: "admin_session" })
      .execute(),
  ).rejects.toMatchObject({ cause: { code: "23514" } });
  const [admin] = await connection.db
    .insert(caps)
    .values({
      ...input(),
      clientId: null,
      resource: testEnvironment().adminResourceIdentifier,
      grantKind: "admin_session",
      scopes: ["org:read"],
    })
    .returning();
  expect(admin!.grantKind).toBe("admin_session");
  await connection.db
    .update(caps)
    .set({ status: "disabled" })
    .where(eq(caps.id, row!.id));
  const [updated] = await connection.db
    .select()
    .from(caps)
    .where(eq(caps.id, row!.id));
  expect(updated!.revision).toBe(2);
  await expect(
    connection.db
      .update(caps)
      .set({ revision: 77 })
      .where(eq(caps.id, row!.id))
      .execute(),
  ).rejects.toMatchObject({ cause: { code: "23514" } });
});
