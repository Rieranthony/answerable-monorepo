import * as productionQueries from "./oauth-clients.ts";
import { approveMachineCapability } from "../../__tests__/capabilities.ts";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { testEnvironment } from "../../__tests__/support.ts";
import { createId } from "../../lib/id.ts";
import { createDatabase, type DatabaseConnection } from "../client.ts";
import { oauthClients, organizations } from "../schema/index.ts";
import { findClientPrincipal } from "../../__tests__/client-queries.ts";

let connection: DatabaseConnection;
beforeAll(() => {
  connection = createDatabase(testEnvironment());
});
beforeEach(async () => {
  await connection.db.execute(
    sql`truncate table audit_events, organizations, oauth_clients, oauth_resources cascade`,
  );
});
afterAll(async () => {
  await connection.close();
});

test("integration: finds the client ceiling and owning organisation", async () => {
  const organizationId = createId();
  await connection.db
    .insert(organizations)
    .values({ id: organizationId, slug: "tenant", name: "Tenant" });
  await connection.db.insert(oauthClients).values({
    id: createId(),
    clientId: "owned",
    redirectUris: [],
    organizationId,
    clientCredentialsScopes: ["org:read"],
  });
  await createResource(connection.db, {
    identifier: "https://admin.example",
    name: "Admin",
    allowedScopes: ["org:read"],
  });
  await queries.linkClientResource(
    connection.db,
    "owned",
    "https://admin.example",
  );
  await approveMachineCapability(connection.db, {
    organizationId,
    clientId: "owned",
    resource: "https://admin.example",
    scopes: ["org:read"],
  });
  expect(
    await findClientPrincipal(connection.db, "owned", "https://admin.example"),
  ).toEqual({
    id: expect.any(String),
    authorizationVersion: 1,
    isPlatform: false,
    clientId: "owned",
    disabled: false,
    clientCredentialsScopes: ["org:read"],
    resourceScopes: ["org:read"],
    organizationId,
    organization: {
      id: organizationId,
      slug: "tenant",
      status: "active",
      authorizationVersion: 1,
    },
  });
});
test("integration: preserves an unowned client through the left join", async () => {
  await connection.db.insert(oauthClients).values({
    id: createId(),
    clientId: "unowned",
    redirectUris: [],
    disabled: true,
  });
  await createResource(connection.db, {
    identifier: "https://admin.example",
    name: "Admin",
    allowedScopes: [],
  });
  await queries.linkClientResource(
    connection.db,
    "unowned",
    "https://admin.example",
  );
  expect(
    await findClientPrincipal(
      connection.db,
      "unowned",
      "https://admin.example",
    ),
  ).toEqual({
    id: expect.any(String),
    authorizationVersion: 1,
    isPlatform: false,
    clientId: "unowned",
    disabled: true,
    clientCredentialsScopes: null,
    resourceScopes: [],
    organizationId: null,
    organization: null,
  });
});
test("integration: returns null for an unknown client, including inside a transaction", async () => {
  expect(
    await connection.db.transaction((tx) =>
      findClientPrincipal(tx, "unknown", "https://admin.example"),
    ),
  ).toBeNull();
});

import * as queries from "../../__tests__/client-queries.ts";
import { createResource } from "../../__tests__/resource-queries.ts";
test("client administration queries cover writes, filters, pagination, missing rows and resource links", async () => {
  const db = connection.db;
  const organizationId = createId();
  await db
    .insert(organizations)
    .values({ id: organizationId, slug: "owner", name: "Owner" });
  const a = await queries.createClient(db, {
    clientId: "alpha",
    name: "First",
    redirectUris: [],
    organizationId,
  });
  const b = await queries.createClient(db, {
    clientId: "beta",
    name: "Second",
    redirectUris: [],
  });
  const c = await queries.createClient(db, {
    clientId: "gamma",
    name: "Third",
    redirectUris: [],
  });
  expect(await queries.findClient(db, a.clientId)).toEqual(a);
  expect(await queries.lockClient(db, a.clientId)).toEqual(a);
  expect(
    (await queries.listClients(db, { limit: 1 })).map((r) => r.id),
  ).toEqual([c.id, b.id]);
  expect(
    (await queries.listClients(db, { limit: 2, cursor: b.id })).map(
      (r) => r.id,
    ),
  ).toEqual([a.id]);
  for (const q of ["ALPHA", "fIrSt"])
    expect(
      (await queries.listClients(db, { limit: 10, q })).map((r) => r.id),
    ).toEqual([a.id]);
  expect(
    (await queries.listClients(db, { limit: 10, organizationId })).map(
      (r) => r.id,
    ),
  ).toEqual([a.id]);
  expect(
    await queries.updateClient(db, a.clientId, {
      name: "Changed",
      contacts: ["owner@example.com"],
    }),
  ).toMatchObject({ name: "Changed", contacts: ["owner@example.com"] });
  expect(await queries.setClientDisabled(db, a.clientId, true)).toMatchObject({
    disabled: true,
  });
  expect(
    (await queries.listClients(db, { limit: 10, disabled: true })).map(
      (r) => r.id,
    ),
  ).toEqual([a.id]);
  expect(
    (await queries.listClients(db, { limit: 10, disabled: false })).map(
      (r) => r.id,
    ),
  ).toEqual([c.id, b.id]);
  expect(await queries.setClientDisabled(db, a.clientId, false)).toMatchObject({
    disabled: false,
  });
  expect(await queries.setClientSecret(db, a.clientId, "digest")).toMatchObject(
    { clientSecret: "digest" },
  );
  expect(await queries.findClient(db, "missing")).toBeNull();
  expect(await queries.lockClient(db, "missing")).toBeNull();
  expect(
    await queries.updateClient(db, "missing", { name: "Missing" }),
  ).toBeNull();
  expect(await queries.setClientDisabled(db, "missing", true)).toBeNull();
  expect(await queries.setClientSecret(db, "missing", "digest")).toBeNull();
  const resource = `https://${createId()}.example`;
  await createResource(db, {
    identifier: resource,
    name: "MCP",
    allowedScopes: ["read"],
  });
  expect(await queries.listClientResources(db, a.clientId)).toEqual([]);
  expect(
    await queries.linkClientResource(db, a.clientId, resource),
  ).toMatchObject({
    created: true,
  });
  expect(
    await queries.linkClientResource(db, a.clientId, resource),
  ).toMatchObject({
    created: false,
  });
  expect(await queries.listClientResources(db, a.clientId)).toMatchObject([
    { clientId: a.clientId, resourceId: resource },
  ]);
  expect(await queries.listClientResources(db, b.clientId)).toEqual([]);
  expect(
    await queries.unlinkClientResource(db, b.clientId, resource),
  ).toBeNull();
  expect(
    await queries.unlinkClientResource(db, a.clientId, resource),
  ).toMatchObject({ deletedAt: expect.any(Date) });
  expect(
    await queries.unlinkClientResource(db, a.clientId, resource),
  ).toBeNull();
});

test("client administration rejects raw database authority", async () => {
  await expect(
    Promise.resolve().then(() =>
      Reflect.apply(productionQueries.listClients, undefined, [
        connection.db,
        { limit: 10 },
      ]),
    ),
  ).rejects.toThrow("Invalid or expired");
});

test("client query authority cannot be copied, reused or widened", async () => {
  const { inPlatformRead, inPlatformWrite, inPlatformUsers } =
    await import("../../__tests__/platform-context.ts");
  const { inTenantRead } = await import("../../__tests__/tenant-command.ts");
  const organizationId = createId();
  await connection.db
    .insert(organizations)
    .values({ id: organizationId, slug: "context", name: "Context" });
  const clientId = "context-client";
  const resource = "https://context.example";
  const reads = [
    [productionQueries.listClients, [{ limit: 10 }]],
    [productionQueries.readClient, [clientId]],
    [productionQueries.listClientResources, [clientId]],
  ] as const;
  const tenantReads = [
    [productionQueries.findClientForAccess, [clientId]],
  ] as const;
  const writes = [
    [productionQueries.readClientForPolicy, [clientId]],
    [productionQueries.lockClientForCommand, [clientId]],
    [productionQueries.createClient, [{ clientId, redirectUris: [] }]],
    [productionQueries.updateClient, [clientId, { name: "Invalid" }]],
    [productionQueries.setClientDisabled, [clientId, true]],
    [productionQueries.setClientSecret, [clientId, "invalid"]],
    [productionQueries.linkClientResource, [clientId, resource]],
    [productionQueries.unlinkClientResource, [clientId, resource]],
    [productionQueries.countClientEntitlements, [clientId]],
    [productionQueries.deleteClient, [clientId]],
  ] as const;
  const all = [...reads, ...tenantReads, ...writes];
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
  await inPlatformRead(connection.db, async (context) => {
    expired = context;
    await reject({ ...context }, all);
    await reject(context, [...writes, ...tenantReads]);
    expect(await productionQueries.readClient(context, clientId)).toBeNull();
  });
  await reject(expired, all);
  await inPlatformWrite(connection.db, async (context) => {
    expired = context;
    await reject({ ...context }, all);
    await reject(context, [...reads, ...tenantReads]);
    expect(
      await productionQueries.readClientForPolicy(context, clientId),
    ).toBeNull();
  });
  await reject(expired, all);
  await inPlatformUsers(connection.db, (context) => reject(context, all));
  for (const access of [
    "directory",
    "configuration",
    "memberAccess",
    "history",
  ] as const) {
    await inTenantRead(
      connection.db,
      organizationId,
      access,
      async (context) => {
        expired = context;
        await reject({ ...context }, all);
        await reject(context, [...reads, ...writes]);
        if (access !== "directory") await reject(context, tenantReads);
      },
    );
    await reject(expired, all);
  }
});
