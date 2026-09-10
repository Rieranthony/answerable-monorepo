import { platformWriteService } from "../__tests__/platform-context.ts";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { testEnvironment } from "../__tests__/support.ts";
import { createDatabase, type DatabaseConnection } from "../db/client.ts";
import {
  auditEvents,
  entitlements,
  organizations,
  oauthClients,
  oauthResources,
  oauthClientResources,
} from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";
import type { Actor } from "./actor.ts";
import * as implementation from "./resources.ts";
import { inPlatformRead } from "../__tests__/platform-context.ts";
import type { Database } from "../db/client.ts";
const service = {
  ...implementation,
  createResource: platformWriteService(implementation.createResource),
  updateResource: platformWriteService(implementation.updateResource),
  disableResource: platformWriteService(implementation.disableResource),
  enableResource: platformWriteService(implementation.enableResource),
  eraseResource: platformWriteService(implementation.eraseResource),
  listResources: (
    db: Database,
    query: Parameters<typeof implementation.listResources>[1],
  ) =>
    inPlatformRead(db, (context) =>
      implementation.listResources(context, query),
    ),
  getResource: (db: Database, id: string) =>
    inPlatformRead(db, (context) => implementation.getResource(context, id)),
};

let connection: DatabaseConnection;
const environment = testEnvironment();
const actor: Actor = {
  actorType: "system",
  actorId: "root",
  requestId: "resource-service-test",
};
const input = {
  identifier: "https://mcp.example.com",
  name: "MCP",
  allowedScopes: ["read"],
};
beforeAll(() => {
  connection = createDatabase(environment);
});
beforeEach(async () => {
  await connection.db.execute(
    sql`truncate table security_identifiers, audit_events, organizations, oauth_resources cascade`,
  );
});
afterAll(async () => {
  await connection.close();
});

test("resource lifecycle attributes exactly one audit per write and preserves update changes", async () => {
  const db = connection.db;
  const row = await service.createResource(db, actor, input);
  expect(await service.getResource(db, input.identifier)).toEqual({
    ...row,
    clients: [],
  });
  expect(await service.listResources(db, { limit: 2 })).toEqual({
    items: [row],
    nextCursor: null,
  });
  const patch = {
    name: "Renamed",
    allowedScopes: ["write"],
    accessTokenTtl: 120,
    refreshTokenTtl: 600,
  };
  expect(
    await service.updateResource(db, actor, row.identifier, patch),
  ).toMatchObject(patch);
  expect(await service.enableResource(db, actor, row.identifier)).toMatchObject(
    { changed: false, resource: { disabled: false } },
  );
  expect(
    await service.disableResource(db, actor, row.identifier),
  ).toMatchObject({ changed: true, resource: { disabled: true } });
  expect(
    await service.disableResource(db, actor, row.identifier),
  ).toMatchObject({ changed: false, resource: { disabled: true } });
  expect(await service.enableResource(db, actor, row.identifier)).toMatchObject(
    { changed: true, resource: { disabled: false } },
  );
  await service.eraseResource(db, actor, row.identifier, row.identifier);
  const events = await db.select().from(auditEvents).orderBy(auditEvents.id);
  expect(events.map((e) => e.action)).toEqual([
    "resource.created",
    "resource.updated",
    "resource.state_unchanged",
    "resource.disabled",
    "resource.state_unchanged",
    "resource.enabled",
    "resource.erased",
  ]);
  for (const event of events)
    expect(event).toMatchObject({
      ...actor,
      targetType: "resource",
      targetId: row.identifier,
      outcome: "success",
      organizationId: null,
    });
  expect(events[0]?.data).toMatchObject({ before: null, after: input });
  expect(events[1]?.data).toMatchObject({
    before: { name: input.name },
    after: patch,
    requestedFields: Object.keys(patch).sort(),
  });
});
test("missing resources, confirmation mismatch and entitlement references fail without audit", async () => {
  const db = connection.db;
  for (const run of [
    () => service.getResource(db, input.identifier),
    () =>
      service.updateResource(db, actor, input.identifier, { name: "Missing" }),
    () => service.disableResource(db, actor, input.identifier),
    () => service.enableResource(db, actor, input.identifier),
    () => service.eraseResource(db, actor, input.identifier, input.identifier),
  ])
    await expect(run()).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
  expect(await db.select().from(auditEvents)).toHaveLength(0);
  await expect(
    service.eraseResource(db, actor, input.identifier, "https://wrong.example"),
  ).rejects.toMatchObject({ status: 404, code: "not_found" });
  const row = await service.createResource(db, actor, input);
  await expect(
    service.eraseResource(db, actor, row.identifier, "https://wrong.example"),
  ).rejects.toMatchObject({ status: 400, code: "confirmation_mismatch" });
  const organizationId = createId();
  await db
    .insert(organizations)
    .values({ id: organizationId, name: "Owner", slug: "owner" });
  await db.insert(entitlements).values({
    id: createId(),
    organizationId,
    resource: row.identifier,
    scopes: ["read"],
  });
  await expect(
    service.eraseResource(db, actor, row.identifier, row.identifier),
  ).rejects.toMatchObject({ status: 409, code: "resource_has_entitlements" });
  expect(await db.select().from(auditEvents)).toHaveLength(1);
  await db
    .delete(entitlements)
    .where(eq(entitlements.resource, row.identifier));
  await service.eraseResource(db, actor, row.identifier, row.identifier);
});
test("audit failures roll back every resource write", async () => {
  const db = connection.db;
  const bad = { ...actor, requestId: "\0" };
  await expect(service.createResource(db, bad, input)).rejects.toThrow();
  await expect(service.getResource(db, input.identifier)).rejects.toMatchObject(
    { status: 404 },
  );
  const row = await service.createResource(db, actor, input);
  await expect(
    service.updateResource(db, bad, row.identifier, { name: "Failed" }),
  ).rejects.toThrow();
  await expect(
    service.disableResource(db, bad, row.identifier),
  ).rejects.toThrow();
  expect(await service.getResource(db, row.identifier)).toMatchObject({
    name: "MCP",
    disabled: false,
  });
  await service.disableResource(db, actor, row.identifier);
  await expect(
    service.enableResource(db, bad, row.identifier),
  ).rejects.toThrow();
  expect(await service.getResource(db, row.identifier)).toMatchObject({
    disabled: true,
  });
  await expect(
    service.eraseResource(db, bad, row.identifier, row.identifier),
  ).rejects.toThrow();
  expect(await service.getResource(db, row.identifier)).toMatchObject({
    disabled: true,
  });
  expect(await db.select().from(auditEvents)).toHaveLength(2);
});

test("resource erasure requires explicit unlinking in both the service and database", async () => {
  const db = connection.db;
  const row = await service.createResource(db, actor, input);
  await db
    .insert(oauthClients)
    .values({ id: createId(), clientId: "linked", redirectUris: [] });
  await db
    .insert(oauthClientResources)
    .values({ id: createId(), clientId: "linked", resourceId: row.identifier });
  await expect(
    service.eraseResource(db, actor, row.identifier, row.identifier),
  ).rejects.toMatchObject({ status: 409, code: "resource_has_clients" });
  await expect(
    db.delete(oauthResources).where(eq(oauthResources.id, row.id)).execute(),
  ).rejects.toMatchObject({
    cause: {
      code: "23503",
      constraint: "oauth_client_resources_resource_id_fk",
    },
  });
  expect(await db.select().from(oauthClientResources)).toHaveLength(1);
  expect(await db.select().from(auditEvents)).toHaveLength(1);
  await db
    .delete(oauthClientResources)
    .where(eq(oauthClientResources.resourceId, row.identifier));
  await service.eraseResource(db, actor, row.identifier, row.identifier);
  expect(await db.select().from(oauthResources)).toHaveLength(0);
  expect(await db.select().from(oauthClients)).toHaveLength(1);
});
