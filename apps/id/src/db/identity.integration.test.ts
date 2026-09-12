import { entitlements } from "./schema/index.ts";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { testEnvironment } from "../__tests__/support.ts";
import { createId } from "../lib/id.ts";
import { createDatabase, type DatabaseConnection } from "./client.ts";
import { oauthClients, oauthResources, organizations } from "./schema/index.ts";

let connection: DatabaseConnection;
let client: typeof oauthClients.$inferSelect;
beforeAll(() => {
  connection = createDatabase(testEnvironment({ databasePoolMax: 2 }));
});
afterAll(async () => connection.close());
beforeEach(async () => {
  await connection.db.execute(
    sql`truncate audit_events, organizations, oauth_clients, oauth_resources cascade`,
  );
  const organizationId = createId();
  await connection.db
    .insert(organizations)
    .values({ id: organizationId, slug: "identity", name: "Identity" });
  [client] = (await connection.db
    .insert(oauthClients)
    .values({
      id: createId(),
      clientId: "immutable",
      organizationId,
      redirectUris: [],
    })
    .returning()) as [typeof client];
});

test("database rejects client identity changes and version rollback", async () => {
  for (const patch of [
    { id: createId() },
    { clientId: "replacement" },
    { organizationId: null },
  ]) {
    await expect(
      connection.db
        .update(oauthClients)
        .set(patch)
        .where(eq(oauthClients.id, client.id))
        .execute(),
    ).rejects.toThrow();
  }
  await connection.db.update(oauthClients).set({ authorizationVersion: 4 });
  await expect(
    connection.db
      .update(oauthClients)
      .set({ authorizationVersion: 3 })
      .execute(),
  ).rejects.toThrow();
  expect((await connection.db.select().from(oauthClients))[0]).toMatchObject({
    id: client.id,
    clientId: client.clientId,
    organizationId: client.organizationId,
    authorizationVersion: 4,
  });
  const [unowned] = await connection.db
    .insert(oauthClients)
    .values({
      id: createId(),
      clientId: "unowned",
      redirectUris: [],
    })
    .returning();
  await expect(
    connection.db
      .update(oauthClients)
      .set({ organizationId: client.organizationId })
      .where(eq(oauthClients.id, unowned!.id))
      .execute(),
  ).rejects.toThrow();
});

test("credential and disable writes advance version at the database boundary", async () => {
  let version = 1;
  for (const patch of [
    { clientSecret: "new-digest" },
    { jwks: "new-key" },
    { jwksUri: "https://keys.example" },
    { tokenEndpointAuthMethod: "private_key_jwt" },
    { disabled: true },
  ]) {
    const [changed] = await connection.db
      .update(oauthClients)
      .set(patch)
      .returning();
    expect(changed!.authorizationVersion).toBe(++version);
  }
  const [enabled] = await connection.db
    .update(oauthClients)
    .set({ disabled: false, name: "Renamed" })
    .returning();
  expect(enabled!.authorizationVersion).toBe(version);
  const [unchanged] = await connection.db
    .update(oauthClients)
    .set({ clientSecret: "new-digest" })
    .returning();
  expect(unchanged!.authorizationVersion).toBe(version);
});

test("database rejects resource identity changes", async () => {
  await connection.db.insert(oauthResources).values({
    id: createId(),
    identifier: "https://resource.example",
    name: "Resource",
  });
  for (const patch of [
    { id: createId() },
    { identifier: "https://replacement.example" },
  ])
    await expect(
      connection.db.update(oauthResources).set(patch).execute(),
    ).rejects.toThrow();
  expect(
    await connection.db
      .update(oauthResources)
      .set({ name: "Renamed" })
      .returning(),
  ).toHaveLength(1);
});

test("deleted client and resource identifiers remain permanently reserved", async () => {
  await connection.db
    .update(oauthClients)
    .set({ deletedAt: new Date(), disabled: true, clientSecret: null })
    .where(eq(oauthClients.id, client.id));
  await expect(
    connection.db
      .insert(oauthClients)
      .values({ ...client, id: createId() })
      .execute(),
  ).rejects.toThrow();
  await expect(
    connection.db
      .insert(oauthClients)
      .values({ ...client, clientId: "different-name" })
      .execute(),
  ).rejects.toThrow();
  const resource = {
    id: createId(),
    identifier: "https://reserved.example",
    name: "Reserved",
  };
  await connection.db.insert(oauthResources).values(resource);
  await connection.db
    .update(oauthResources)
    .set({ deletedAt: new Date(), disabled: true });
  await expect(
    connection.db
      .insert(oauthResources)
      .values({ ...resource, id: createId() })
      .execute(),
  ).rejects.toThrow();
});

test("rolled back creation does not reserve an identifier", async () => {
  await expect(
    connection.db.transaction(async (tx) => {
      await tx
        .insert(oauthClients)
        .values({ id: createId(), clientId: "rolled-back", redirectUris: [] });
      throw new Error("rollback");
    }),
  ).rejects.toThrow("rollback");
  expect(
    await connection.db
      .insert(oauthClients)
      .values({ id: createId(), clientId: "rolled-back", redirectUris: [] })
      .returning(),
  ).toHaveLength(1);
});

test("concurrent creation commits one identity", async () => {
  const outcomes = await Promise.allSettled(
    [1, 2].map(async () => {
      return connection.db
        .insert(oauthClients)
        .values({ id: createId(), clientId: "concurrent", redirectUris: [] })
        .returning();
    }),
  );
  expect(
    outcomes.filter((outcome) => outcome.status === "fulfilled"),
  ).toHaveLength(1);
  expect(
    outcomes.filter((outcome) => outcome.status === "rejected"),
  ).toHaveLength(1);
});

test("configuration revisions cover SQL changes, reject forged revisions and leave SQL no-ops unchanged", async () => {
  expect(client.revision).toBe(1);
  for (const revision of [0, 2, 100])
    await expect(
      connection.db.update(oauthClients).set({ revision }).execute(),
    ).rejects.toThrow();
  await connection.db.execute(sql`update oauth_clients set name = name`);
  expect((await connection.db.select().from(oauthClients))[0]!.revision).toBe(
    1,
  );
  await connection.db.execute(sql`update oauth_clients set name = 'changed'`);
  expect((await connection.db.select().from(oauthClients))[0]!.revision).toBe(
    2,
  );
  await connection.db.execute(
    sql`update oauth_clients set client_secret = 'digest'`,
  );
  expect((await connection.db.select().from(oauthClients))[0]).toMatchObject({
    revision: 3,
    authorizationVersion: 2,
  });
});

test("resource link insertion, movement and explicit removal advance affected client revisions", async () => {
  const resource = "https://revision.example";
  await connection.db
    .insert(oauthResources)
    .values({ id: createId(), identifier: resource, name: "Revision" });
  const revision = async () =>
    (
      await connection.db
        .select()
        .from(oauthClients)
        .where(eq(oauthClients.id, client.id))
    )[0]!.revision;
  const linkId = createId();
  await connection.db.execute(
    sql`insert into oauth_client_resources (id, client_id, resource_id) values (${linkId}, ${client.clientId}, ${resource})`,
  );
  expect(await revision()).toBe(2);
  await connection.db.execute(
    sql`insert into oauth_client_resources (id, client_id, resource_id) values (${createId()}, ${client.clientId}, ${resource}) on conflict do nothing`,
  );
  expect(await revision()).toBe(2);
  await connection.db.execute(
    sql`update oauth_client_resources set metadata = '{"note":"unchanged visible link"}'`,
  );
  expect(await revision()).toBe(2);
  await connection.db
    .insert(oauthClients)
    .values({ id: createId(), clientId: "other-client", redirectUris: [] });
  await connection.db.execute(
    sql`update oauth_client_resources set client_id = 'other-client' where id = ${linkId}`,
  );
  expect(await revision()).toBe(3);
  await expect(
    connection.db.delete(oauthResources).execute(),
  ).rejects.toMatchObject({ cause: { code: "23503" } });
  await connection.db.execute(
    sql`delete from oauth_client_resources where id = ${linkId}`,
  );
  await connection.db.delete(oauthResources);
  expect(
    (
      await connection.db
        .select()
        .from(oauthClients)
        .where(eq(oauthClients.clientId, "other-client"))
    )[0]!.revision,
  ).toBe(3);
  await connection.db.delete(oauthClients);
});

test("resource configuration revisions reject manual writes and include link movement", async () => {
  const a = "https://revision-a.example";
  const b = "https://revision-b.example";
  for (const identifier of [a, b])
    await connection.db
      .insert(oauthResources)
      .values({ id: createId(), identifier, name: "Resource" });
  const revision = async (identifier: string) =>
    (
      await connection.db
        .select()
        .from(oauthResources)
        .where(eq(oauthResources.identifier, identifier))
    )[0]!.revision;
  await expect(
    connection.db.update(oauthResources).set({ revision: 4 }).execute(),
  ).rejects.toThrow();
  await connection.db.execute(sql`update oauth_resources set name = name`);
  expect(await revision(a)).toBe(1);
  await connection.db.execute(
    sql`update oauth_resources set name = 'Changed' where identifier = ${a}`,
  );
  expect(await revision(a)).toBe(2);
  const id = createId();
  await connection.db.execute(
    sql`insert into oauth_client_resources (id, client_id, resource_id) values (${id}, ${client.clientId}, ${a})`,
  );
  expect(await revision(a)).toBe(3);
  await connection.db.execute(
    sql`update oauth_client_resources set resource_id = ${b} where id = ${id}`,
  );
  expect(await revision(a)).toBe(4);
  expect(await revision(b)).toBe(2);
});

test("organisation authorization version advances on disable and cannot roll back", async () => {
  const db = connection.db;
  await db
    .update(organizations)
    .set({ status: "disabled", disabledAt: new Date() });
  expect((await db.select().from(organizations))[0]!.authorizationVersion).toBe(
    2,
  );
  await db.update(organizations).set({ status: "disabled" });
  expect((await db.select().from(organizations))[0]!.authorizationVersion).toBe(
    2,
  );
  await db.update(organizations).set({ status: "active", disabledAt: null });
  expect((await db.select().from(organizations))[0]!.authorizationVersion).toBe(
    2,
  );
  await expect(
    db.update(organizations).set({ authorizationVersion: 1 }).execute(),
  ).rejects.toThrow();
  await expect(
    db.update(organizations).set({ authorizationVersion: 0 }).execute(),
  ).rejects.toThrow();
  await db.update(organizations).set({ authorizationVersion: 5 });
  await db
    .update(organizations)
    .set({ status: "disabled", disabledAt: new Date() });
  expect((await db.select().from(organizations))[0]!.authorizationVersion).toBe(
    6,
  );
  expect((await db.select().from(oauthClients))[0]!.authorizationVersion).toBe(
    1,
  );
});

test("resource classification and immutable owner survive configuration changes", async () => {
  const db = connection.db;
  const identifier = "https://private.example/resource";
  const [resource] = await db
    .insert(oauthResources)
    .values({
      id: createId(),
      identifier,
      name: "Private",
      classification: "tenant_owned",
      organizationId: client.organizationId,
    })
    .returning();
  for (const patch of [
    { organizationId: null },
    { classification: "platform_shared" as const, organizationId: null },
    { organizationId: createId() },
  ])
    await expect(
      db
        .update(oauthResources)
        .set(patch)
        .where(eq(oauthResources.id, resource!.id))
        .execute(),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  await db
    .update(oauthResources)
    .set({ name: "Renamed" })
    .where(eq(oauthResources.id, resource!.id));
  expect(
    (
      await db
        .select()
        .from(oauthResources)
        .where(eq(oauthResources.id, resource!.id))
    )[0],
  ).toMatchObject({
    classification: "tenant_owned",
    organizationId: client.organizationId,
    name: "Renamed",
  });
  await expect(
    db
      .delete(organizations)
      .where(eq(organizations.id, client.organizationId!))
      .execute(),
  ).rejects.toMatchObject({ cause: { code: "23503" } });
  for (const [classification, owner] of [
    ["unknown", null],
    ["tenant_owned", null],
    ["platform_shared", client.organizationId],
  ] as const)
    await expect(
      Promise.resolve(
        db.execute(
          sql`insert into oauth_resources (id, identifier, name, classification, organization_id) values (${createId()}, ${`https://${createId()}.example`}, 'Invalid', ${classification}, ${owner})`,
        ),
      ),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  await expect(
    db
      .insert(oauthResources)
      .values({
        id: createId(),
        identifier: "https://missing-owner.example",
        name: "Missing",
        classification: "tenant_owned",
        organizationId: createId(),
      })
      .execute(),
  ).rejects.toMatchObject({ cause: { code: "23503" } });
  const [shared] = await db
    .insert(oauthResources)
    .values({
      id: createId(),
      identifier: "https://shared.example",
      name: "Shared",
    })
    .returning();
  expect(shared).toMatchObject({
    classification: "platform_shared",
    organizationId: null,
  });
});

test("private resource assignments cannot cross tenants through raw writes", async () => {
  const db = connection.db;
  const other = createId();
  await db
    .insert(organizations)
    .values({ id: other, slug: `other-${other}`, name: "Other" });
  const resource = `https://${createId()}.example/private`;
  await db.insert(oauthResources).values({
    id: createId(),
    identifier: resource,
    name: "Private",
    classification: "tenant_owned",
    organizationId: client.organizationId,
  });
  const assignment = {
    id: createId(),
    organizationId: client.organizationId!,
    resource,
    scopes: ["read"],
  };
  await db.insert(entitlements).values(assignment);
  await expect(
    db
      .insert(entitlements)
      .values({ ...assignment, id: createId(), organizationId: other })
      .execute(),
  ).rejects.toMatchObject({ cause: { code: "23503" } });
  await expect(
    db
      .insert(entitlements)
      .values({
        ...assignment,
        id: createId(),
        clientId: client.clientId,
        organizationId: other,
      })
      .execute(),
  ).rejects.toMatchObject({ cause: { code: "23503" } });
  expect(
    await db
      .insert(entitlements)
      .values({ ...assignment, id: createId(), clientId: client.clientId })
      .returning(),
  ).toMatchObject([
    {
      clientId: client.clientId,
      resource,
      organizationId: client.organizationId,
    },
  ]);
  await expect(
    db
      .update(entitlements)
      .set({ organizationId: other })
      .where(eq(entitlements.id, assignment.id))
      .execute(),
  ).rejects.toMatchObject({ cause: { code: "23503" } });
  expect(
    (
      await db
        .select()
        .from(entitlements)
        .where(eq(entitlements.id, assignment.id))
    )[0]?.organizationId,
  ).toBe(client.organizationId!);
});
