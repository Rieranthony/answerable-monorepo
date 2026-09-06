import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { testEnvironment } from "../__tests__/support.ts";
import { createDatabase, type DatabaseConnection } from "../db/client.ts";
import { createOrganization } from "../db/queries/organizations.ts";
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
  actorType: "user",
  actorId: createId(),
  requestId: "service-test",
  ip: "192.0.2.1",
  userAgent: "test",
};
const invalidActor = { ...actor, requestId: "\0" };
import * as service from "./domains.ts";
import { findOrganizationDomain } from "../db/queries/organization-domains.ts";
test("domain lifecycle writes have one attributed audit and reject repeats, foreign rows and missing organisations", async () => {
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
  await expect(
    service.enableDomain(db, actor, org.id, row.id),
  ).rejects.toMatchObject({ status: 409, code: "domain_already_active" });
  expect(await service.disableDomain(db, actor, org.id, row.id)).toMatchObject({
    status: "disabled",
  });
  await expect(
    service.disableDomain(db, actor, org.id, row.id),
  ).rejects.toMatchObject({ status: 409, code: "domain_already_disabled" });
  expect(await service.enableDomain(db, actor, org.id, row.id)).toMatchObject({
    status: "active",
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
  expect(events).toHaveLength(3);
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
    "domain.disabled",
    "domain.enabled",
  ]);
  expect(events[0]?.data).toEqual({ domain: row.domain });
  expect(events[1]?.data).toEqual({ status: "disabled" });
  expect(events[2]?.data).toEqual({ status: "active" });
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
