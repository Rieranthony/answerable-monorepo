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
import * as service from "./sso-providers.ts";
import { findSsoProviderByOrganization } from "../db/queries/sso-providers.ts";
import { ssoProviders } from "../db/schema/index.ts";
import { eq } from "drizzle-orm";
const input = {
  issuer: "https://login.example.com",
  domain: "acme.example.com",
  oidc: { clientId: "client", clientSecret: "private-secret" },
};
test("provider upsert keeps omitted secrets, replaces supplied secrets, redacts reads and audits each write", async () => {
  const db = connection.db;
  const org = await createOrganization(db, { slug: "alpha", name: "Alpha" });
  const created = await service.putSsoProvider(db, actor, org.id, input);
  expect(created.created).toBe(true);
  expect(created.provider).toMatchObject({
    providerId: org.slug,
    organizationId: org.id,
    oidc: { hasClientSecret: true },
  });
  expect(await service.getSsoProvider(db, org.id)).toEqual(created.provider);
  const updated = await service.putSsoProvider(db, actor, org.id, {
    ...input,
    oidc: { clientId: "changed" },
  });
  expect(updated.created).toBe(false);
  expect(updated.provider.oidc).toMatchObject({
    clientId: "changed",
    hasClientSecret: true,
  });
  expect(
    JSON.parse((await findSsoProviderByOrganization(db, org.id))!.oidcConfig!)
      .clientSecret,
  ).toBe("private-secret");
  await service.putSsoProvider(db, actor, org.id, {
    ...input,
    oidc: { clientId: "changed", clientSecret: "replacement-secret" },
  });
  expect(
    JSON.parse((await findSsoProviderByOrganization(db, org.id))!.oidcConfig!)
      .clientSecret,
  ).toBe("replacement-secret");
  await service.deleteSsoProvider(db, actor, org.id);
  await expect(service.getSsoProvider(db, org.id)).rejects.toMatchObject({
    status: 404,
    code: "not_found",
  });
  const events = await db.select().from(auditEvents).orderBy(auditEvents.id);
  expect(events).toHaveLength(4);
  expect(events.map((event) => event.action)).toEqual([
    "sso_provider.created",
    "sso_provider.updated",
    "sso_provider.updated",
    "sso_provider.deleted",
  ]);
  for (const event of events)
    expect(event).toMatchObject({
      ...actor,
      organizationId: org.id,
      targetType: "sso_provider",
      targetId: created.provider.id,
      outcome: "success",
      data: {},
    });
  for (const value of [created.provider, updated.provider, events]) {
    expect(JSON.stringify(value)).not.toContain('"clientSecret"');
    expect(JSON.stringify(value)).not.toContain("private-secret");
    expect(JSON.stringify(value)).not.toContain("replacement-secret");
  }
});
test("missing provider and organisation paths produce 404 without audit", async () => {
  const db = connection.db;
  const org = await createOrganization(db, { slug: "alpha", name: "Alpha" });
  for (const id of [org.id, createId()]) {
    await expect(service.getSsoProvider(db, id)).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
    await expect(
      service.deleteSsoProvider(db, actor, id),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
  }
  await expect(
    service.putSsoProvider(db, actor, createId(), input),
  ).rejects.toMatchObject({ status: 404, code: "not_found" });
  expect(await db.select().from(auditEvents)).toHaveLength(0);
});
test("secretless and null configurations can be updated, and all audit failures roll back", async () => {
  const db = connection.db;
  const org = await createOrganization(db, { slug: "alpha", name: "Alpha" });
  await expect(
    service.putSsoProvider(db, invalidActor, org.id, input),
  ).rejects.toThrow();
  expect(await findSsoProviderByOrganization(db, org.id)).toBeNull();
  const created = await service.putSsoProvider(db, actor, org.id, {
    ...input,
    oidc: { clientId: "public" },
  });
  expect(created.provider.oidc.hasClientSecret).toBe(false);
  await expect(
    service.putSsoProvider(db, invalidActor, org.id, input),
  ).rejects.toThrow();
  expect(await service.getSsoProvider(db, org.id)).toEqual(created.provider);
  await expect(
    service.deleteSsoProvider(db, invalidActor, org.id),
  ).rejects.toThrow();
  expect(await service.getSsoProvider(db, org.id)).toEqual(created.provider);
  await db
    .update(ssoProviders)
    .set({ oidcConfig: null })
    .where(eq(ssoProviders.id, created.provider.id));
  const updated = await service.putSsoProvider(db, actor, org.id, {
    ...input,
    oidc: { clientId: "public" },
  });
  expect(updated.provider.oidc.hasClientSecret).toBe(false);
  expect(await db.select().from(auditEvents)).toHaveLength(2);
});
