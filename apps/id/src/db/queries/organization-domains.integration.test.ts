import { eq } from "drizzle-orm";
import { organizations, organizationDomains } from "../schema/index.ts";
import { findDomainOrganizationSlug } from "./organization-domains.ts";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import * as queries from "../../__tests__/domain-queries.ts";
import { createOrganization } from "../../__tests__/organization-queries.ts";
import { testEnvironment } from "../../__tests__/support.ts";
import { createId } from "../../lib/id.ts";
import { createDatabase, type DatabaseConnection } from "../client.ts";
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

test("domain routing requires an active, undeleted domain and organisation", async () => {
  const db = connection.db;
  const organization = await createOrganization(db, {
    slug: "routing",
    name: "Routing",
  });
  const domain = await queries.createOrganizationDomain(db, {
    organizationId: organization.id,
    domain: "routing.example.com",
  });
  expect(await findDomainOrganizationSlug(db, domain.domain)).toBe("routing");
  expect(await findDomainOrganizationSlug(db, " ROUTING.EXAMPLE.COM ")).toBe(
    "routing",
  );
  expect(
    await findDomainOrganizationSlug(db, "unknown.example.com"),
  ).toBeNull();
  for (const [index, target] of [
    organizationDomains,
    organizationDomains,
    organizations,
    organizations,
  ].entries()) {
    const owner = await createOrganization(db, {
      slug: `routing-${index}`,
      name: "Routing",
    });
    const entry = await queries.createOrganizationDomain(db, {
      organizationId: owner.id,
      domain: `routing-${index}.example.com`,
    });
    await db
      .update(target)
      .set({
        status: "disabled",
        ...(target === organizations ? { disabledAt: new Date() } : {}),
        ...(index % 2 ? { deletedAt: new Date() } : {}),
      })
      .where(eq(target.id, target === organizations ? owner.id : entry.id));
    expect(await findDomainOrganizationSlug(db, entry.domain)).toBeNull();
  }
});
