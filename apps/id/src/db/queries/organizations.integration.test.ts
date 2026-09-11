import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { testEnvironment } from "../../__tests__/support.ts";
import { createId } from "../../lib/id.ts";
import { createDatabase, type DatabaseConnection } from "../client.ts";
import { members, oauthClients, users } from "../schema/index.ts";

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

import * as queries from "../../__tests__/organization-queries.ts";

test("organisation queries: CRUD, filters, cursor, missing rows and related IDs", async () => {
  const db = connection.db;
  const a = await queries.createOrganization(db, {
    slug: "alpha",
    name: "First",
    logo: "https://example.com/a",
    metadata: "{}",
  });
  const b = await queries.createOrganization(db, {
    slug: "beta",
    name: "Second",
  });
  const c = await queries.createOrganization(db, {
    slug: "gamma",
    name: "Third",
  });
  expect(await queries.findOrganization(db, a.id)).toEqual(a);
  expect(await queries.lockOrganization(db, a.id)).toEqual(a);
  expect(
    (await queries.listOrganizations(db, { limit: 1 })).map((r) => r.id),
  ).toEqual([c.id, b.id]);
  expect(
    (await queries.listOrganizations(db, { limit: 2, cursor: b.id })).map(
      (r) => r.id,
    ),
  ).toEqual([a.id]);
  for (const q of ["ALPHA", "fIRsT"])
    expect(
      (await queries.listOrganizations(db, { limit: 10, q })).map((r) => r.id),
    ).toEqual([a.id]);
  expect(
    await queries.updateOrganization(db, a.id, {
      name: "Changed",
      logo: null,
      metadata: null,
    }),
  ).toMatchObject({ name: "Changed", logo: null, metadata: null });
  expect(
    await queries.setOrganizationStatus(db, a.id, "disabled"),
  ).toMatchObject({ status: "disabled", disabledAt: expect.any(Date) });
  expect(
    (
      await queries.listOrganizations(db, { limit: 10, status: "disabled" })
    ).map((r) => r.id),
  ).toEqual([a.id]);
  expect(await queries.setOrganizationStatus(db, a.id, "active")).toMatchObject(
    { disabledAt: null },
  );
  expect(await queries.countOrganizationClients(db, a.id)).toBe(0);
  const userId = createId();
  await db
    .insert(users)
    .values({ id: userId, name: "Member", email: "member@example.com" });
  await db
    .insert(members)
    .values({ id: createId(), organizationId: a.id, userId });
  await db.insert(oauthClients).values({
    id: createId(),
    clientId: "owned",
    organizationId: a.id,
    redirectUris: [],
  });
  expect(await queries.countOrganizationClients(db, a.id)).toBe(1);
  await queries.deleteOrganization(db, b.id);
  expect(await queries.findOrganization(db, b.id)).toMatchObject({
    id: b.id,
    status: "disabled",
    deletedAt: expect.any(Date),
  });
  expect(await queries.lockOrganization(db, b.id)).toBeNull();
  expect(
    await queries.updateOrganization(db, b.id, { name: "Missing" }),
  ).toBeNull();
  expect(await queries.setOrganizationStatus(db, b.id, "disabled")).toBeNull();
  await queries.deleteOrganization(db, b.id);
});
