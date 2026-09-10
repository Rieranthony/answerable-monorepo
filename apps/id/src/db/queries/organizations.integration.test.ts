import * as productionQueries from "./organizations.ts";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { testEnvironment } from "../../__tests__/support.ts";
import { createDatabase, type DatabaseConnection } from "../client.ts";
import { createId } from "../../lib/id.ts";
import { users, members, oauthClients } from "../schema/index.ts";

let connection: DatabaseConnection;
beforeAll(() => {
  connection = createDatabase(testEnvironment());
});
beforeEach(async () => {
  await connection.db.execute(
    sql`truncate table audit_events, security_identifiers, organizations, users cascade`,
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

test("organisation administration rejects raw database authority", async () => {
  await expect(
    Promise.resolve().then(() =>
      Reflect.apply(productionQueries.listOrganizations, undefined, [
        connection.db,
        { limit: 10 },
      ]),
    ),
  ).rejects.toThrow("Invalid or expired");
});

test("organisation query contexts cannot be copied, reused or widened", async () => {
  const { inPlatformRead, inPlatformWrite } =
    await import("../../__tests__/platform-context.ts");
  const { inTenantRead } = await import("../../__tests__/tenant-command.ts");
  const org = await queries.createOrganization(connection.db, {
    slug: "context",
    name: "Context",
  });
  const platform = [
    [productionQueries.listOrganizations, [{ limit: 10 }]],
  ] as const;
  const directory = [[productionQueries.readOrganization, []]] as const;
  const diagnosis = [[productionQueries.readOrganizationStatus, []]] as const;
  const history = [
    [productionQueries.organizationExistsForHistory, []],
  ] as const;
  const writes = [
    [productionQueries.lockOrganizationForCommand, [org.id]],
    [
      productionQueries.createOrganization,
      [{ slug: "invalid", name: "Invalid" }],
    ],
    [productionQueries.updateOrganization, [org.id, { name: "Invalid" }]],
    [productionQueries.setOrganizationStatus, [org.id, "disabled"]],
    [productionQueries.deleteOrganization, [org.id]],
    [productionQueries.countOrganizationClients, [org.id]],
  ] as const;
  const all = [...platform, ...directory, ...diagnosis, ...history, ...writes];
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
    await reject(context, [
      ...platform,
      ...directory,
      ...diagnosis,
      ...history,
    ]);
  });
  await reject(expired, all);
  await inPlatformRead(connection.db, async (context) => {
    expired = context;
    await reject({ ...context }, all);
    await reject(context, [...writes, ...directory, ...diagnosis, ...history]);
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
      if (access !== "history") await reject(context, history);
    });
    await reject(expired, all);
  }
});
