import { afterAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { testEnvironment } from "./__tests__/support.ts";
import { assertDisposableTestDatabase } from "./__tests__/test-database.ts";
import {
  bootstrap,
  platformAdminsGroupSlug,
  platformScopes,
  type BootstrapOptions,
} from "./bootstrap.ts";
import { createDatabase } from "./db/client.ts";
import {
  auditEvents,
  entitlements,
  groups,
  oauthResources,
  organizations,
} from "./db/schema/index.ts";
import { adminScopes } from "./http/admin/scopes.ts";

const connection = createDatabase(testEnvironment());
const db = connection.db;
const options: BootstrapOptions = {
  platformOrganizationSlug: "answerable",
  platformOrganizationName: "Answerable",
  adminResourceIdentifier: "https://id.answerable.org/api/admin",
};
const actor = {
  actorType: "client" as const,
  actorId: "seed-test",
  requestId: "seed-request",
  ip: "192.0.2.1",
  userAgent: "seed-test-agent",
};

beforeEach(async () => {
  assertDisposableTestDatabase("truncate bootstrap fixtures");
  await db.execute(
    sql`truncate table organizations, users, oauth_resources, oauth_clients, audit_events cascade`,
  );
});
afterAll(async () => {
  await connection.close();
});

async function rows() {
  return {
    organization: await db.select().from(organizations),
    resource: await db.select().from(oauthResources),
    group: await db.select().from(groups),
    entitlement: await db.select().from(entitlements),
  };
}

const auditChanges = (created: boolean, updated = false) =>
  Object.fromEntries(
    ["organization", "resource", "group", "entitlement"].map((key) => [
      key,
      { created, updated },
    ]),
  );

test("creates the complete platform, repeats without changes and repairs drift", async () => {
  const first = await bootstrap(db, actor, options);
  for (const row of Object.values(first)) expect(row.created).toBe(true);
  const seeded = await rows();
  for (const table of Object.values(seeded)) expect(table).toHaveLength(1);
  expect(seeded.organization[0]).toMatchObject({
    id: first.organization.id,
    slug: "answerable",
    name: "Answerable",
    status: "active",
  });
  expect(seeded.resource[0]).toMatchObject({
    id: first.resource.id,
    identifier: options.adminResourceIdentifier,
    name: "Answerable ID admin API",
    accessTokenTtl: 600,
    allowedScopes: [...adminScopes],
    disabled: false,
  });
  expect(seeded.group[0]).toMatchObject({
    id: first.group.id,
    organizationId: first.organization.id,
    slug: platformAdminsGroupSlug,
    name: "Platform admins",
    status: "active",
  });
  expect(seeded.entitlement[0]).toMatchObject({
    id: first.entitlement.id,
    organizationId: first.organization.id,
    groupId: first.group.id,
    memberId: null,
    clientId: null,
    resource: options.adminResourceIdentifier,
    scopes: platformScopes,
  });
  let audit = await db.select().from(auditEvents).orderBy(auditEvents.id);
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({
    action: "bootstrap.applied",
    ...actor,
    organizationId: first.organization.id,
    targetType: "organization",
    targetId: first.organization.id,
    outcome: "success",
    data: auditChanges(true),
  });
  const second = await bootstrap(db, actor, options);
  for (const row of Object.values(second)) {
    expect(row.created).toBe(false);
    if ("updated" in row) expect(row.updated).toBe(false);
  }
  expect(await rows()).toEqual(seeded);
  audit = await db.select().from(auditEvents).orderBy(auditEvents.id);
  expect(audit).toHaveLength(2);
  expect(audit[1]!.data).toEqual(auditChanges(false));

  await db
    .update(oauthResources)
    .set({ accessTokenTtl: 42, name: "Drift", allowedScopes: [] })
    .where(eq(oauthResources.id, first.resource.id));
  await db
    .update(entitlements)
    .set({ scopes: ["platform:read"] })
    .where(eq(entitlements.id, first.entitlement.id));
  const third = await bootstrap(db, actor, {
    ...options,
    platformOrganizationName: "Answerable platform",
  });
  for (const row of [third.organization, third.resource, third.entitlement])
    expect(row.updated).toBe(true);
  for (const row of Object.values(third)) expect(row.created).toBe(false);
  const repaired = await rows();
  expect(repaired.organization[0]!.name).toBe("Answerable platform");
  expect(repaired.resource[0]).toMatchObject({
    accessTokenTtl: 600,
    name: "Answerable ID admin API",
    allowedScopes: [...adminScopes],
  });
  expect(repaired.entitlement[0]!.scopes).toEqual(platformScopes);
  audit = await db.select().from(auditEvents).orderBy(auditEvents.id);
  expect(audit).toHaveLength(3);
  expect(audit[2]!.data).toEqual({
    ...auditChanges(false),
    organization: { created: false, updated: true },
    resource: { created: false, updated: true },
    entitlement: { created: false, updated: true },
  });
});

test("rolls back the organisation when the resource insert fails", async () => {
  await expect(
    bootstrap(db, actor, {
      ...options,
      adminResourceIdentifier: null as unknown as string,
    }),
  ).rejects.toThrow();
  for (const table of Object.values(await rows()))
    expect(table).toHaveLength(0);
  expect(await db.select().from(auditEvents)).toHaveLength(0);
});

test("rolls back every seeded row when the audit insert fails", async () => {
  await expect(
    bootstrap(
      db,
      { ...actor, actorType: "invalid" as typeof actor.actorType },
      options,
    ),
  ).rejects.toThrow();
  for (const table of Object.values(await rows()))
    expect(table).toHaveLength(0);
  expect(await db.select().from(auditEvents)).toHaveLength(0);
});
