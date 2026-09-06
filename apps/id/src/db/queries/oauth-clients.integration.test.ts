import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { testEnvironment } from "../../__tests__/support.ts";
import { createId } from "../../lib/id.ts";
import { createDatabase, type DatabaseConnection } from "../client.ts";
import { oauthClients, organizations } from "../schema/index.ts";
import { findClientPrincipal } from "./oauth-clients.ts";

let connection: DatabaseConnection;
beforeAll(() => {
  connection = createDatabase(testEnvironment());
});
beforeEach(async () => {
  await connection.db.execute(
    sql`truncate table organizations, oauth_clients cascade`,
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
  expect(await findClientPrincipal(connection.db, "owned")).toEqual({
    clientId: "owned",
    disabled: false,
    clientCredentialsScopes: ["org:read"],
    organizationId,
    organization: { id: organizationId, slug: "tenant", status: "active" },
  });
});
test("integration: preserves an unowned client through the left join", async () => {
  await connection.db.insert(oauthClients).values({
    id: createId(),
    clientId: "unowned",
    redirectUris: [],
    disabled: true,
  });
  expect(await findClientPrincipal(connection.db, "unowned")).toEqual({
    clientId: "unowned",
    disabled: true,
    clientCredentialsScopes: null,
    organizationId: null,
    organization: null,
  });
});
test("integration: returns null for an unknown client, including inside a transaction", async () => {
  expect(
    await connection.db.transaction((tx) => findClientPrincipal(tx, "unknown")),
  ).toBeNull();
});

import * as queries from "./oauth-clients.ts";
import { createResource } from "./oauth-resources.ts";
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
  expect(
    await db.transaction((tx) => queries.lockClient(tx, a.clientId)),
  ).toEqual(a);
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
  expect(
    await queries.assignClientOrganization(db, {
      clientId: a.clientId,
      organizationId: null,
    }),
  ).toMatchObject({ organizationId: null });
  expect(await queries.findClient(db, "missing")).toBeNull();
  expect(await queries.lockClient(db, "missing")).toBeNull();
  expect(
    await queries.updateClient(db, "missing", { name: "Missing" }),
  ).toBeNull();
  expect(await queries.setClientDisabled(db, "missing", true)).toBeNull();
  expect(await queries.setClientSecret(db, "missing", "digest")).toBeNull();
  await expect(
    queries.assignClientOrganization(db, {
      clientId: "missing",
      organizationId,
    }),
  ).rejects.toBeInstanceOf(queries.OAuthClientNotFoundError);
  const resource = `https://${createId()}.example`;
  await createResource(db, {
    identifier: resource,
    name: "MCP",
    allowedScopes: ["read"],
  });
  expect(await queries.listClientResources(db, a.clientId)).toEqual([]);
  expect(await queries.linkClientResource(db, a.clientId, resource)).toEqual({
    created: true,
  });
  expect(
    await db.transaction((tx) =>
      queries.linkClientResource(tx, a.clientId, resource),
    ),
  ).toEqual({ created: false });
  expect(await queries.listClientResources(db, a.clientId)).toMatchObject([
    { clientId: a.clientId, resourceId: resource },
  ]);
  expect(await queries.listClientResources(db, b.clientId)).toEqual([]);
  expect(await queries.unlinkClientResource(db, b.clientId, resource)).toBe(
    false,
  );
  expect(await queries.unlinkClientResource(db, a.clientId, resource)).toBe(
    true,
  );
  expect(await queries.unlinkClientResource(db, a.clientId, resource)).toBe(
    false,
  );
});
