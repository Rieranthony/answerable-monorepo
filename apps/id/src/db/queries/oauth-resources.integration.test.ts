import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import * as queries from "../../__tests__/resource-queries.ts";
import { testEnvironment } from "../../__tests__/support.ts";
import { createId } from "../../lib/id.ts";
import { createDatabase, type DatabaseConnection } from "../client.ts";
import { entitlements, organizations } from "../schema/index.ts";
let connection: DatabaseConnection;
beforeAll(() => {
  connection = createDatabase(testEnvironment());
});
beforeEach(async () => {
  await connection.db.execute(
    sql`truncate table audit_events, organizations, oauth_resources cascade`,
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
