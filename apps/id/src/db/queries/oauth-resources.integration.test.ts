import * as productionQueries from "./oauth-resources.ts";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { testEnvironment } from "../../__tests__/support.ts";
import { createDatabase, type DatabaseConnection } from "../client.ts";
import { entitlements, organizations } from "../schema/index.ts";
import { createId } from "../../lib/id.ts";
import * as queries from "../../__tests__/resource-queries.ts";
let connection: DatabaseConnection;
beforeAll(() => {
  connection = createDatabase(testEnvironment());
});
beforeEach(async () => {
  await connection.db.execute(
    sql`truncate table audit_events, security_identifiers, organizations, oauth_resources cascade`,
  );
});
afterAll(async () => {
  await connection.close();
});
test("resource queries cover CRUD, filters, cursors, locks and entitlement references", async () => {
  const db = connection.db;
  const rows = [];
  for (const [identifier, name] of [
    ["alpha", "First"],
    ["beta", "Second"],
    ["gamma", "Third"],
  ])
    rows.push(
      await queries.createResource(db, {
        identifier: `https://${identifier}.example`,
        name: name!,
        allowedScopes: ["read"],
      }),
    );
  const [a, b, c] = rows;
  expect(await queries.findResource(db, a!.identifier)).toEqual(a);
  expect(await queries.lockResource(db, a!.identifier)).toEqual(a!);
  expect(
    (await queries.listResources(db, { limit: 1 })).map((r) => r.id),
  ).toEqual([c!.id, b!.id]);
  expect(
    (await queries.listResources(db, { limit: 2, cursor: b!.id })).map(
      (r) => r.id,
    ),
  ).toEqual([a!.id]);
  for (const q of ["ALPHA", "fIrSt"])
    expect(
      (await queries.listResources(db, { limit: 10, q })).map((r) => r.id),
    ).toEqual([a!.id]);
  expect(
    await queries.updateResource(db, a!.identifier, {
      name: "Changed",
      accessTokenTtl: 120,
    }),
  ).toMatchObject({ name: "Changed", accessTokenTtl: 120 });
  expect(
    await queries.setResourceDisabled(db, a!.identifier, true),
  ).toMatchObject({ disabled: true });
  expect(
    (await queries.listResources(db, { limit: 10, disabled: true })).map(
      (r) => r.id,
    ),
  ).toEqual([a!.id]);
  expect(
    (await queries.listResources(db, { limit: 10, disabled: false })).map(
      (r) => r.id,
    ),
  ).toEqual([c!.id, b!.id]);
  expect(
    await queries.setResourceDisabled(db, a!.identifier, false),
  ).toMatchObject({ disabled: false });
  expect(await queries.countResourceEntitlements(db, a!.identifier)).toBe(0);
  const organizationId = createId();
  await db
    .insert(organizations)
    .values({ id: organizationId, slug: "tenant", name: "Tenant" });
  await db.insert(entitlements).values({
    id: createId(),
    organizationId,
    resource: a!.identifier,
    scopes: ["read"],
  });
  expect(await queries.countResourceEntitlements(db, a!.identifier)).toBe(1);
  await expect(queries.deleteResource(db, a!.identifier)).rejects.toThrow();
  await db.delete(entitlements).where(eq(entitlements.resource, a!.identifier));
  await queries.deleteResource(db, a!.identifier);
  expect(await queries.findResource(db, a!.identifier)).toBeNull();
  expect(await queries.lockResource(db, a!.identifier)).toBeNull();
  expect(
    await queries.updateResource(db, a!.identifier, { name: "Missing" }),
  ).toBeNull();
  expect(await queries.setResourceDisabled(db, a!.identifier, true)).toBeNull();
  await queries.deleteResource(db, a!.identifier);
});

test("resource administration rejects raw database authority", async () => {
  await expect(
    Promise.resolve().then(() =>
      Reflect.apply(productionQueries.listResources, undefined, [
        connection.db,
        { limit: 10 },
      ]),
    ),
  ).rejects.toThrow("Invalid or expired");
});

test("resource queries reject copied, expired and wrong-purpose authority", async () => {
  const { inPlatformRead, inPlatformWrite, inPlatformUsers } =
    await import("../../__tests__/platform-context.ts");
  const { inTenantRead } = await import("../../__tests__/tenant-command.ts");
  const organizationId = createId();
  await connection.db
    .insert(organizations)
    .values({ id: organizationId, slug: "context", name: "Context" });
  const identifier = "https://context.example";
  const reads = [
    [productionQueries.listResources, [{ limit: 10 }]],
    [productionQueries.readResource, [identifier]],
    [productionQueries.listResourceClients, [identifier]],
  ] as const;
  const tenantReads = [
    [productionQueries.findResourceForAccess, [identifier]],
  ] as const;
  const writes = [
    [productionQueries.readResourceForPolicy, [identifier]],
    [productionQueries.lockResourceForCommand, [identifier]],
    [
      productionQueries.createResource,
      [{ identifier, name: "Context", allowedScopes: ["read"] }],
    ],
    [productionQueries.updateResource, [identifier, { name: "Invalid" }]],
    [productionQueries.setResourceDisabled, [identifier, true]],
    [productionQueries.deleteResource, [identifier]],
    [productionQueries.countResourceEntitlements, [identifier]],
    [productionQueries.hasResourceClients, [identifier]],
  ] as const;
  const all = [...reads, ...tenantReads, ...writes];
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
  await inPlatformRead(connection.db, async (context) => {
    expired = context;
    await reject({ ...context }, all);
    await reject(context, [...tenantReads, ...writes]);
  });
  await reject(expired, all);
  await inPlatformWrite(connection.db, async (context) => {
    expired = context;
    await reject({ ...context }, all);
    await reject(context, [...tenantReads, ...reads]);
  });
  await reject(expired, all);
  await inPlatformUsers(connection.db, (context) => reject(context, all));
  for (const access of [
    "directory",
    "configuration",
    "memberAccess",
    "history",
  ] as const) {
    await inTenantRead(
      connection.db,
      organizationId,
      access,
      async (context) => {
        expired = context;
        await reject({ ...context }, all);
        await reject(context, [...reads, ...writes]);
        if (access !== "directory") await reject(context, tenantReads);
      },
    );
    await reject(expired, all);
  }
});
