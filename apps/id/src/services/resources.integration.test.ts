import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { testEnvironment } from "../__tests__/support.ts";
import { createDatabase, type DatabaseConnection } from "../db/client.ts";
import {
  auditEvents,
  entitlements,
  organizations,
} from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";
import type { Actor } from "./actor.ts";
import * as service from "./resources.ts";

let connection: DatabaseConnection;
const environment = testEnvironment();
const actor: Actor = {
  actorType: "user",
  actorId: createId(),
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
    sql`truncate table audit_events, organizations, oauth_resources cascade`,
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
  await expect(
    service.enableResource(db, actor, row.identifier),
  ).rejects.toMatchObject({ status: 409, code: "resource_already_active" });
  expect(
    await service.disableResource(db, actor, row.identifier, environment),
  ).toMatchObject({ disabled: true });
  await expect(
    service.disableResource(db, actor, row.identifier, environment),
  ).rejects.toMatchObject({ status: 409, code: "resource_already_disabled" });
  expect(await service.enableResource(db, actor, row.identifier)).toMatchObject(
    { disabled: false },
  );
  await service.eraseResource(
    db,
    actor,
    row.identifier,
    row.identifier,
    environment,
  );
  const events = await db.select().from(auditEvents).orderBy(auditEvents.id);
  expect(events.map((e) => e.action)).toEqual([
    "resource.created",
    "resource.updated",
    "resource.disabled",
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
  expect(events[0]?.data).toEqual(input);
  expect(events[1]?.data).toEqual({ changes: patch });
});
test("missing resources, confirmation mismatch, protected resource and entitlement references fail without audit", async () => {
  const db = connection.db;
  for (const run of [
    () => service.getResource(db, input.identifier),
    () =>
      service.updateResource(db, actor, input.identifier, { name: "Missing" }),
    () => service.disableResource(db, actor, input.identifier, environment),
    () => service.enableResource(db, actor, input.identifier),
    () =>
      service.eraseResource(
        db,
        actor,
        input.identifier,
        input.identifier,
        environment,
      ),
  ])
    await expect(run()).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
  expect(await db.select().from(auditEvents)).toHaveLength(0);
  await expect(
    service.eraseResource(
      db,
      actor,
      input.identifier,
      "https://wrong.example",
      environment,
    ),
  ).rejects.toMatchObject({ status: 404, code: "not_found" });
  await service.createResource(db, actor, {
    ...input,
    identifier: environment.adminResourceIdentifier,
  });
  for (const run of [
    () =>
      service.disableResource(
        db,
        actor,
        environment.adminResourceIdentifier,
        environment,
      ),
    () =>
      service.eraseResource(
        db,
        actor,
        environment.adminResourceIdentifier,
        environment.adminResourceIdentifier,
        environment,
      ),
  ])
    await expect(
      Promise.resolve().then(async () => {
        await run();
      }),
    ).rejects.toMatchObject({ status: 409, code: "resource_protected" });
  const row = await service.createResource(db, actor, input);
  await expect(
    service.eraseResource(
      db,
      actor,
      row.identifier,
      "https://wrong.example",
      environment,
    ),
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
    service.eraseResource(
      db,
      actor,
      row.identifier,
      row.identifier,
      environment,
    ),
  ).rejects.toMatchObject({ status: 409, code: "resource_has_entitlements" });
  expect(await db.select().from(auditEvents)).toHaveLength(2);
  await db
    .delete(entitlements)
    .where(eq(entitlements.resource, row.identifier));
  await service.eraseResource(
    db,
    actor,
    row.identifier,
    row.identifier,
    environment,
  );
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
    service.disableResource(db, bad, row.identifier, environment),
  ).rejects.toThrow();
  expect(await service.getResource(db, row.identifier)).toMatchObject({
    name: "MCP",
    disabled: false,
  });
  await service.disableResource(db, actor, row.identifier, environment);
  await expect(
    service.enableResource(db, bad, row.identifier),
  ).rejects.toThrow();
  expect(await service.getResource(db, row.identifier)).toMatchObject({
    disabled: true,
  });
  await expect(
    service.eraseResource(db, bad, row.identifier, row.identifier, environment),
  ).rejects.toThrow();
  expect(await service.getResource(db, row.identifier)).toMatchObject({
    disabled: true,
  });
  expect(await db.select().from(auditEvents)).toHaveLength(2);
});
