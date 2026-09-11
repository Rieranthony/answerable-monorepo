import * as domainQueries from "./organization-domains.ts";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
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
    sql`truncate table audit_events, organizations, users cascade`,
  );
});
afterAll(async () => {
  await connection.close();
});
import * as queries from "../../__tests__/domain-queries.ts";
test("domain queries scope rows, paginate newest first, filter and enforce active ownership", async () => {
  const db = connection.db;
  const a = await createOrganization(db, { slug: "alpha", name: "Alpha" });
  const b = await createOrganization(db, { slug: "beta", name: "Beta" });
  const first = await queries.createOrganizationDomain(db, {
    organizationId: a.id,
    domain: " FIRST.EXAMPLE.COM ",
  });
  const second = await queries.createOrganizationDomain(db, {
    organizationId: a.id,
    domain: "second.example.com",
  });
  const third = await queries.createOrganizationDomain(db, {
    organizationId: a.id,
    domain: "third.example.com",
  });
  expect(first.domain).toBe("first.example.com");
  expect(await queries.findOrganizationDomain(db, a.id, first.id)).toEqual(
    first,
  );
  expect(await queries.findOrganizationDomain(db, b.id, first.id)).toBeNull();
  expect(await queries.findOrganizationDomain(db, a.id, createId())).toBeNull();
  expect(
    (await queries.listOrganizationDomains(db, a.id, { limit: 1 })).map(
      (row) => row.id,
    ),
  ).toEqual([third.id, second.id]);
  expect(
    (
      await queries.listOrganizationDomains(db, a.id, {
        limit: 1,
        cursor: second.id,
      })
    ).map((row) => row.id),
  ).toEqual([first.id]);
  expect(
    await queries.listOrganizationDomains(db, b.id, { limit: 10 }),
  ).toEqual([]);
  expect(
    await queries.setOrganizationDomainStatus(db, b.id, first.id, "disabled"),
  ).toBeNull();
  expect(
    await queries.setOrganizationDomainStatus(db, a.id, createId(), "disabled"),
  ).toBeNull();
  expect(
    await queries.organizationAcceptsDomain(db, a.id, "FIRST.EXAMPLE.COM"),
  ).toBe(true);
  await expect(
    queries.createOrganizationDomain(db, {
      organizationId: b.id,
      domain: first.domain,
    }),
  ).rejects.toThrow();
  await expect(
    queries.createOrganizationDomain(db, {
      organizationId: a.id,
      domain: first.domain,
    }),
  ).rejects.toThrow();
  expect(
    await queries.setOrganizationDomainStatus(db, a.id, first.id, "disabled"),
  ).toMatchObject({ status: "disabled" });
  expect(await queries.organizationAcceptsDomain(db, a.id, first.domain)).toBe(
    false,
  );
  expect(
    (
      await queries.listOrganizationDomains(db, a.id, {
        limit: 10,
        status: "disabled",
      })
    ).map((row) => row.id),
  ).toEqual([first.id]);
  const other = await queries.createOrganizationDomain(db, {
    organizationId: b.id,
    domain: first.domain,
  });
  await expect(
    queries.setOrganizationDomainStatus(db, a.id, first.id, "active"),
  ).rejects.toThrow();
  await queries.setOrganizationDomainStatus(db, b.id, other.id, "disabled");
  expect(
    await queries.setOrganizationDomainStatus(db, a.id, first.id, "active"),
  ).toMatchObject({ status: "active" });
});

test("domain administration rejects a raw database handle", async () => {
  await expect(
    Promise.resolve().then(() =>
      Reflect.apply(domainQueries.listOrganizationDomains, undefined, [
        connection.db,
        { limit: 10 },
      ]),
    ),
  ).rejects.toThrow("Invalid or expired");
});

test("domain query contexts cannot be copied, reused or widened", async () => {
  const { inTenantRead } = await import("../../__tests__/tenant-command.ts");
  const { inPlatformRead, inPlatformWrite } =
    await import("../../__tests__/platform-context.ts");
  const org = await createOrganization(connection.db, {
    slug: "contexts",
    name: "Contexts",
  });
  const domainId = createId();
  const reads = [
    [domainQueries.listOrganizationDomains, [{ limit: 10 }]],
  ] as const;
  const diagnostics = [
    [domainQueries.organizationAcceptsDomain, ["example.com"]],
  ] as const;
  const writes = [
    [
      domainQueries.createOrganizationDomain,
      [{ organizationId: org.id, domain: "example.com" }],
    ],
    [domainQueries.findOrganizationDomainForCommand, [org.id, domainId]],
    [domainQueries.setOrganizationDomainStatus, [org.id, domainId, "disabled"]],
    [domainQueries.deleteOrganizationDomain, [org.id, domainId]],
  ] as const;
  const all = [...reads, ...diagnostics, ...writes];
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
    await reject(context, [...reads, ...diagnostics]);
    expect(
      await domainQueries.findOrganizationDomainForCommand(
        context,
        org.id,
        domainId,
      ),
    ).toBeNull();
  });
  await reject(expired, all);
  await inPlatformRead(connection.db, (context) => reject(context, all));
  for (const access of [
    "directory",
    "memberAccess",
    "configuration",
    "history",
  ] as const) {
    await inTenantRead(connection.db, org.id, access, async (context) => {
      expired = context;
      await reject({ ...context }, all);
      await reject(context, writes);
      if (access !== "directory") await reject(context, reads);
      if (access !== "memberAccess") await reject(context, diagnostics);
    });
    await reject(expired, all);
  }
});
