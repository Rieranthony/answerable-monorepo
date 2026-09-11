import { inPlatformWrite } from "../__tests__/platform-context.ts";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { testEnvironment } from "../__tests__/support.ts";
import { createDatabase, type DatabaseConnection } from "../db/client.ts";
import { createOrganization } from "../__tests__/organization-queries.ts";
import { createId } from "../lib/id.ts";
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
import { auditEvents } from "../db/schema/index.ts";
import type { Actor } from "./actor.ts";
const actor: Actor = {
  actorType: "system",
  actorId: "root",
  requestId: "service-test",
  ip: "192.0.2.1",
  userAgent: "test",
};
const invalidActor = { ...actor, requestId: "\0" };
import * as implementation from "./domains.ts";
import { inTenantRead } from "../__tests__/tenant-command.ts";
import type { Database } from "../db/client.ts";
const service = {
  ...implementation,

  createDomain: (
    db: Database,
    actor: Actor,
    org: string,
    input: { domain: string },
  ) =>
    inPlatformWrite(
      db,
      (context) => implementation.createDomain(context, org, input),
      actor,
    ),
  disableDomain: (db: Database, actor: Actor, org: string, id: string) =>
    inPlatformWrite(
      db,
      (context) => implementation.disableDomain(context, org, id),
      actor,
    ),
  enableDomain: (db: Database, actor: Actor, org: string, id: string) =>
    inPlatformWrite(
      db,
      (context) => implementation.enableDomain(context, org, id),
      actor,
    ),
  deleteOrganizationDomain: (
    db: Database,
    actor: Actor,
    org: string,
    id: string,
  ) =>
    inPlatformWrite(
      db,
      (context) => implementation.deleteOrganizationDomain(context, org, id),
      actor,
    ),
  listDomains: (
    db: Database,
    org: string,
    arg1: Parameters<typeof implementation.listDomains>[1],
  ) =>
    inTenantRead(db, org, "directory", (context) =>
      implementation.listDomains(context, arg1),
    ),
};
import { findOrganizationDomain } from "../__tests__/domain-queries.ts";
test("domain lifecycle writes have one attributed audit and record noops and reject foreign rows and missing organisations", async () => {
  const db = connection.db;
  const org = await createOrganization(db, { slug: "alpha", name: "Alpha" });
  const other = await createOrganization(db, { slug: "beta", name: "Beta" });
  const row = await service.createDomain(db, actor, org.id, {
    domain: "acme.example.com",
  });
  expect(await service.listDomains(db, org.id, { limit: 1 })).toEqual({
    items: [row],
    nextCursor: null,
  });
  expect(await service.enableDomain(db, actor, org.id, row.id)).toMatchObject({
    domain: row,
    changed: false,
  });
  expect(await service.disableDomain(db, actor, org.id, row.id)).toMatchObject({
    domain: { status: "disabled" },
    changed: true,
  });
  expect(await service.disableDomain(db, actor, org.id, row.id)).toMatchObject({
    domain: { status: "disabled" },
    changed: false,
  });
  expect(await service.enableDomain(db, actor, org.id, row.id)).toMatchObject({
    domain: { status: "active" },
    changed: true,
  });
  for (const id of [createId(), other.id]) {
    await expect(
      service.disableDomain(db, actor, id, row.id),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
    await expect(
      service.enableDomain(db, actor, id, row.id),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
  }
  await expect(
    service.listDomains(db, createId(), { limit: 1 }),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    service.createDomain(db, actor, createId(), {
      domain: "missing.example.com",
    }),
  ).rejects.toMatchObject({ status: 404 });
  const events = await db.select().from(auditEvents).orderBy(auditEvents.id);
  expect(events).toHaveLength(5);
  for (const event of events)
    expect(event).toMatchObject({
      ...actor,
      organizationId: org.id,
      targetType: "domain",
      targetId: row.id,
      outcome: "success",
    });
  expect(events.map((event) => event.action)).toEqual([
    "domain.created",
    "domain.enable_unchanged",
    "domain.disabled",
    "domain.disable_unchanged",
    "domain.enabled",
  ]);
  expect(events[0]?.data).toMatchObject({
    domain: row.domain,
    before: null,
    after: { id: row.id, organizationId: org.id, status: "active" },
  });
  expect(events[1]?.data).toMatchObject({
    before: { status: "active" },
    after: { status: "active" },
  });
  expect(events[2]?.data).toMatchObject({
    before: { status: "active" },
    after: { status: "disabled" },
  });
  expect(events[4]?.data).toMatchObject({
    before: { status: "disabled" },
    after: { status: "active" },
  });
});
test("domain ownership conflicts and audit failures roll back all writes", async () => {
  const db = connection.db;
  const a = await createOrganization(db, { slug: "alpha", name: "Alpha" });
  const b = await createOrganization(db, { slug: "beta", name: "Beta" });
  const input = { domain: "shared.example.com" };
  await expect(
    service.createDomain(db, invalidActor, a.id, input),
  ).rejects.toThrow();
  expect((await service.listDomains(db, a.id, { limit: 10 })).items).toEqual(
    [],
  );
  const row = await service.createDomain(db, actor, a.id, input);
  await expect(service.createDomain(db, actor, a.id, input)).rejects.toThrow();
  await expect(service.createDomain(db, actor, b.id, input)).rejects.toThrow();
  await expect(
    service.disableDomain(db, invalidActor, a.id, row.id),
  ).rejects.toThrow();
  expect(await findOrganizationDomain(db, a.id, row.id)).toMatchObject({
    status: "active",
  });
  await service.disableDomain(db, actor, a.id, row.id);
  await expect(
    service.enableDomain(db, invalidActor, a.id, row.id),
  ).rejects.toThrow();
  expect(await findOrganizationDomain(db, a.id, row.id)).toMatchObject({
    status: "disabled",
  });
  await service.createDomain(db, actor, b.id, input);
  await expect(service.enableDomain(db, actor, a.id, row.id)).rejects.toThrow();
  expect(await findOrganizationDomain(db, a.id, row.id)).toMatchObject({
    status: "disabled",
  });
  expect(await db.select().from(auditEvents)).toHaveLength(3);
});

test("domain deletion rejects missing and foreign targets and rolls back with its audit", async () => {
  const db = connection.db;
  const org = await createOrganization(db, { slug: "delete", name: "Delete" });
  const other = await createOrganization(db, { slug: "other", name: "Other" });
  const domain = await service.createDomain(db, actor, org.id, {
    domain: "delete.example.com",
  });
  for (const [orgId, domainId] of [
    [createId(), domain.id],
    [other.id, domain.id],
    [org.id, createId()],
  ]) {
    await expect(
      service.deleteOrganizationDomain(db, actor, orgId!, domainId!),
    ).rejects.toMatchObject({ status: 404 });
  }
  await expect(
    service.deleteOrganizationDomain(db, invalidActor, org.id, domain.id),
  ).rejects.toThrow();
  expect(await findOrganizationDomain(db, org.id, domain.id)).not.toBeNull();
  await service.deleteOrganizationDomain(db, actor, org.id, domain.id);
  await expect(
    service.deleteOrganizationDomain(db, actor, org.id, domain.id),
  ).rejects.toMatchObject({ status: 404 });
  const events = await db.select().from(auditEvents).orderBy(auditEvents.id);
  expect(events).toHaveLength(2);
  expect(events[1]).toMatchObject({
    ...actor,
    organizationId: org.id,
    action: "domain.deleted",
    targetType: "domain",
    targetId: domain.id,
    outcome: "success",
  });
});
