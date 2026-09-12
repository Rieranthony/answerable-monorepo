import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import * as queries from "../__tests__/client-queries.ts";
import {
  inPlatformRead,
  platformWriteService,
} from "../__tests__/platform-context.ts";
import { createResource } from "../__tests__/resource-queries.ts";
import { testEnvironment } from "../__tests__/support.ts";
import type { Database } from "../db/client.ts";
import { createDatabase, type DatabaseConnection } from "../db/client.ts";
import {
  auditEvents,
  oauthAccessTokens,
  oauthRefreshTokens,
  organizations,
  users,
} from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";
import type { Actor } from "./actor.ts";
import { hashClientSecret } from "./client-secrets.ts";
import * as implementation from "./clients.ts";
const service = {
  ...implementation,
  createClient: platformWriteService(implementation.createClient),
  updateClient: platformWriteService(
    async (...args: Parameters<typeof implementation.updateClient>) =>
      (await implementation.updateClient(...args)).body,
  ),
  disableClient: platformWriteService(implementation.disableClient),
  enableClient: platformWriteService(implementation.enableClient),
  rotateSecret: platformWriteService(implementation.rotateSecret),
  setOwner: platformWriteService(implementation.setOwner),
  linkResource: platformWriteService(implementation.linkResource),
  unlinkResource: platformWriteService(implementation.unlinkResource),
  eraseClient: platformWriteService(implementation.eraseClient),
  listClients: (
    db: Database,
    query: Parameters<typeof implementation.listClients>[1],
  ) =>
    inPlatformRead(db, (context) => implementation.listClients(context, query)),
  getClient: (db: Database, id: string) =>
    inPlatformRead(db, (context) => implementation.getClient(context, id)),
};

let connection: DatabaseConnection;
let organizationId: string;
const actor: Actor = {
  actorType: "system",
  actorId: "root",
  requestId: "client-service-test",
};
const resource = "https://mcp.example.com";
const publicInput: implementation.CreateClientInput = {
  name: "Browser",
  tokenEndpointAuthMethod: "none",
  grantTypes: ["authorization_code"],
  redirectUris: ["https://app.example/callback"],
};
function machineInput(): implementation.CreateClientInput {
  return {
    clientId: "machine",
    name: "Machine",
    organizationId,
    tokenEndpointAuthMethod: "client_secret_basic",
    grantTypes: ["client_credentials"],
    clientCredentialsScopes: ["read"],
    redirectUris: [],
  };
}
beforeAll(() => {
  connection = createDatabase(testEnvironment());
});
beforeEach(async () => {
  await connection.db.execute(
    sql`truncate table audit_events, organizations, users, oauth_clients, oauth_resources cascade`,
  );
  organizationId = createId();
  await connection.db
    .insert(organizations)
    .values({ id: organizationId, name: "Owner", slug: "owner" });
  await createResource(connection.db, {
    identifier: resource,
    name: "MCP",
    allowedScopes: ["read"],
  });
});
afterAll(async () => {
  await connection.close();
});

test("client lifecycle hides digests, returns secrets once, revokes tokens, changes owners and audits every write", async () => {
  const db = connection.db;
  const input = machineInput();
  const created = await service.createClient(db, actor, input);
  expect(created.clientSecret).toBeString();
  expect(created.hasClientSecret).toBe(true);
  expect(created.responseTypes).toEqual([]);
  const originalDigest = hashClientSecret(created.clientSecret!);
  expect((await queries.findClient(db, created.clientId))?.clientSecret).toBe(
    originalDigest,
  );
  const read = await service.getClient(db, created.clientId);
  expect(read).not.toHaveProperty("clientSecret");
  const page = await service.listClients(db, { limit: 10 });
  const { resources, ...listed } = read;
  expect(resources).toEqual([]);
  expect(page).toEqual({ items: [listed], nextCursor: null });
  const patch = {
    name: "Changed",
    uri: "https://app.example",
    contacts: ["owner@example.com"],
    redirectUris: [],
    postLogoutRedirectUris: ["https://app.example/logout"],
    scopes: ["openid"],
    clientCredentialsScopes: ["read", "write"],
    skipConsent: true,
    backchannelLogoutUri: "https://app.example/backchannel",
  };
  const updated = await service.updateClient(
    db,
    actor,
    created.clientId,
    patch,
  );
  expect(updated).toMatchObject(patch);
  expect(updated).not.toHaveProperty("clientSecret");
  const rotated = await service.rotateSecret(db, actor, created.clientId);
  expect(rotated.clientSecret).not.toBe(created.clientSecret);
  expect((await queries.findClient(db, created.clientId))?.clientSecret).toBe(
    hashClientSecret(rotated.clientSecret),
  );
  expect(hashClientSecret(rotated.clientSecret)).not.toBe(originalDigest);
  const userId = createId();
  await db
    .insert(users)
    .values({ id: userId, name: "User", email: "user@example.com" });
  const token = {
    id: createId(),
    token: createId(),
    clientId: created.clientId,
    userId,
    scopes: ["read"],
    expiresAt: new Date(Date.now() + 60000),
  };
  await db.insert(oauthAccessTokens).values(token);
  await db.insert(oauthRefreshTokens).values({ ...token, id: createId() });
  expect(await service.enableClient(db, actor, created.clientId)).toMatchObject(
    { changed: false, client: { disabled: false } },
  );
  expect(
    await service.disableClient(db, actor, created.clientId),
  ).toMatchObject({ changed: true, client: { disabled: true } });
  expect(
    await service.disableClient(db, actor, created.clientId),
  ).toMatchObject({ changed: false, client: { disabled: true } });
  for (const table of [oauthAccessTokens, oauthRefreshTokens])
    expect((await db.select().from(table))[0]?.revoked).toBeInstanceOf(Date);
  expect(await service.enableClient(db, actor, created.clientId)).toMatchObject(
    { changed: true, client: { disabled: false } },
  );
  expect(
    await service.linkResource(db, actor, created.clientId, resource),
  ).toEqual({ created: true });
  expect(
    await service.linkResource(db, actor, created.clientId, resource),
  ).toEqual({ created: false });
  await service.unlinkResource(db, actor, created.clientId, resource);
  const otherId = createId();
  await db
    .insert(organizations)
    .values({ id: otherId, name: "Other", slug: "other" });
  for (const owner of [otherId, null])
    await expect(
      service.setOwner(db, actor, created.clientId, owner),
    ).rejects.toMatchObject({ status: 409, code: "ownership_conflict" });
  expect(
    await service.setOwner(db, actor, created.clientId, organizationId),
  ).toMatchObject({ organizationId });
  const events = await db.select().from(auditEvents).orderBy(auditEvents.id);
  expect(events.map((e) => e.action)).toEqual([
    "client.created",
    "client.updated",
    "client.secret_rotated",
    "client.state_unchanged",
    "client.grants_revoked",
    "client.disabled",
    "client.state_unchanged",
    "client.enabled",
    "client.resource_linked",
    "client.resource_unchanged",
    "client.resource_unlinked",
    "client.owner_unchanged",
  ]);
  for (const event of events)
    expect(event).toMatchObject({
      ...actor,
      targetType: "client",
      targetId: created.clientId,
      outcome: "success",
    });
  expect(events[1]?.data).toMatchObject({
    requestedFields: Object.keys(patch).sort(),
    before: { name: "Machine", clientCredentialsScopes: ["read"] },
    after: { name: "Changed", clientCredentialsScopes: ["read", "write"] },
  });
  expect(
    events.find((event) => event.action === "client.disabled")?.data,
  ).toMatchObject({ effects: { accessTokens: 1, refreshTokens: 1 } });
  expect(
    events.find((event) => event.action === "client.owner_unchanged")?.data,
  ).toEqual({
    before: { organizationId },
    after: { organizationId },
    changed: false,
  });
  const serialised = JSON.stringify(events);
  for (const secret of [
    created.clientSecret!,
    rotated.clientSecret,
    originalDigest,
    hashClientSecret(rotated.clientSecret),
    "clientSecret",
  ])
    expect(serialised).not.toContain(secret);
});
test("public and private key clients have no secret; generated IDs and response types are server owned", async () => {
  const db = connection.db;
  const browser = await service.createClient(db, actor, publicInput);
  expect(browser.clientId).toMatch(/^client_[0-9a-f]{16}$/);
  expect(browser).toMatchObject({
    requirePKCE: true,
    responseTypes: ["code"],
    hasClientSecret: false,
  });
  expect(browser).not.toHaveProperty("clientSecret");
  expect(
    (await service.listClients(db, { limit: 10 })).items[0],
  ).not.toHaveProperty("clientSecret");
  for (const keys of [
    { jwksUri: "https://app.example/jwks" },
    { jwks: JSON.stringify({ keys: [{ kty: "RSA", n: "abc", e: "AQAB" }] }) },
  ]) {
    const client = await service.createClient(db, actor, {
      ...publicInput,
      tokenEndpointAuthMethod: "private_key_jwt",
      ...keys,
    });
    expect(client.hasClientSecret).toBe(false);
    expect(client).not.toHaveProperty("clientSecret");
    expect(
      (await queries.findClient(db, client.clientId))?.clientSecret,
    ).toBeNull();
    await expect(
      service.rotateSecret(db, actor, client.clientId),
    ).rejects.toMatchObject({ status: 409, code: "client_has_no_secret" });
    expect(
      await service.updateClient(db, actor, client.clientId, {
        jwks: null,
        jwksUri: "https://new.example/jwks",
      }),
    ).toMatchObject({ jwks: null, jwksUri: "https://new.example/jwks" });
  }
  await expect(
    service.rotateSecret(db, actor, browser.clientId),
  ).rejects.toMatchObject({ code: "client_has_no_secret" });
});
test("every cross-field rule rejects creation with field errors and no audit", async () => {
  const db = connection.db;
  const invalid: implementation.CreateClientInput[] = [
    { ...machineInput(), tokenEndpointAuthMethod: "none" },
    { ...machineInput(), clientCredentialsScopes: undefined },
    { ...machineInput(), clientCredentialsScopes: [] },
    { ...machineInput(), organizationId: undefined },
    { ...publicInput, redirectUris: [] },
    { ...publicInput, tokenEndpointAuthMethod: "private_key_jwt" },
    {
      ...publicInput,
      tokenEndpointAuthMethod: "private_key_jwt",
      jwks: "{}",
      jwksUri: "https://app.example/jwks",
    },
    ...["", "not json", "null", "{}", '{"keys":[]}', '{"keys":[{}]}'].map(
      (jwks) => ({
        ...publicInput,
        tokenEndpointAuthMethod: "private_key_jwt" as const,
        jwks,
      }),
    ),
  ];
  for (const input of invalid) {
    try {
      await service.createClient(db, actor, input);
      throw new Error("Unexpected success");
    } catch (error) {
      expect(error).toMatchObject({
        status: 400,
        code: "validation_failed",
        extensions: { errors: expect.any(Array) },
      });
    }
  }
  expect(await db.select().from(auditEvents)).toHaveLength(0);
});
test("updates recheck the stored configuration, including legacy invalid rows", async () => {
  const db = connection.db;
  const machine = await service.createClient(db, actor, machineInput());
  await expect(
    service.updateClient(db, actor, machine.clientId, {
      clientCredentialsScopes: [],
    }),
  ).rejects.toMatchObject({ code: "validation_failed" });
  const browser = await service.createClient(db, actor, publicInput);
  await expect(
    service.updateClient(db, actor, browser.clientId, { redirectUris: [] }),
  ).rejects.toMatchObject({ code: "validation_failed" });
  const privateClient = await service.createClient(db, actor, {
    ...publicInput,
    tokenEndpointAuthMethod: "private_key_jwt",
    jwksUri: "https://app.example/jwks",
  });
  for (const patch of [
    { jwksUri: null },
    { jwks: "{}" },
    { jwksUri: null, jwks: "bad" },
  ])
    await expect(
      service.updateClient(db, actor, privateClient.clientId, patch),
    ).rejects.toMatchObject({ code: "validation_failed" });
  const unowned = await queries.createClient(db, {
    clientId: "unowned-machine",
    redirectUris: [],
    grantTypes: ["client_credentials"],
    tokenEndpointAuthMethod: "client_secret_basic",
    clientCredentialsScopes: ["read"],
  });
  await expect(
    service.updateClient(db, actor, unowned.clientId, { name: "Unowned" }),
  ).rejects.toMatchObject({ code: "validation_failed" });
  const legacy = await queries.createClient(db, {
    clientId: "legacy",
    redirectUris: [],
    tokenEndpointAuthMethod: "none",
    grantTypes: ["client_credentials"],
    organizationId,
    clientCredentialsScopes: ["read"],
  });
  await expect(
    service.updateClient(db, actor, legacy.clientId, { name: "Legacy" }),
  ).rejects.toMatchObject({ code: "validation_failed" });
  const empty = await queries.createClient(db, {
    clientId: "empty",
    redirectUris: [],
  });
  await expect(
    service.setOwner(db, actor, empty.clientId, organizationId),
  ).rejects.toMatchObject({ status: 409, code: "ownership_conflict" });
  expect(await service.setOwner(db, actor, empty.clientId, null)).toMatchObject(
    { organizationId: null },
  );
  expect(
    await service.updateClient(db, actor, empty.clientId, { name: "Empty" }),
  ).toMatchObject({ name: "Empty" });
});
test("unknown clients, organisations and resources return 404 without successful audit", async () => {
  const db = connection.db;
  for (const run of [
    () => service.getClient(db, "missing"),
    () => service.updateClient(db, actor, "missing", { name: "Missing" }),
    () => service.disableClient(db, actor, "missing"),
    () => service.enableClient(db, actor, "missing"),
    () => service.rotateSecret(db, actor, "missing"),
    () => service.setOwner(db, actor, "missing", null),
    () => service.linkResource(db, actor, "missing", resource),
    () => service.unlinkResource(db, actor, "missing", resource),
    () =>
      service.createClient(db, actor, {
        ...machineInput(),
        organizationId: createId(),
      }),
  ])
    await expect(run()).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
  expect(await db.select().from(auditEvents)).toHaveLength(0);
  const client = await service.createClient(db, actor, machineInput());
  await expect(
    service.setOwner(db, actor, client.clientId, createId()),
  ).rejects.toMatchObject({ status: 409, code: "ownership_conflict" });
  await expect(
    service.linkResource(db, actor, client.clientId, "https://missing.example"),
  ).rejects.toMatchObject({ status: 404, code: "not_found" });
  expect(
    await service.unlinkResource(db, actor, client.clientId, resource),
  ).toEqual({ removed: false });
  expect(await db.select().from(auditEvents)).toHaveLength(2);
});

test("erasure checks existence, confirmation and entitlements in order", async () => {
  const db = connection.db;
  await expect(
    service.eraseClient(db, actor, "missing", "wrong"),
  ).rejects.toMatchObject({ status: 404 });
  const client = await service.createClient(db, actor, machineInput());
  const { createEntitlement, deleteEntitlement } =
    await import("../__tests__/entitlement-queries.ts");
  const grant = await createEntitlement(db, {
    organizationId,
    clientId: client.clientId,
    scopes: ["read"],
  });
  await expect(
    service.eraseClient(db, actor, client.clientId, "wrong"),
  ).rejects.toMatchObject({ status: 400, code: "confirmation_mismatch" });
  await expect(
    service.eraseClient(db, actor, client.clientId, client.clientId),
  ).rejects.toMatchObject({ status: 409, code: "client_has_entitlements" });
  expect(await db.select().from(auditEvents)).toHaveLength(1);
  await deleteEntitlement(db, organizationId, grant.id);
  await service.linkResource(db, actor, client.clientId, resource);
  await service.eraseClient(db, actor, client.clientId, client.clientId);
  expect(await queries.findClient(db, client.clientId)).toBeNull();
  const unowned = await service.createClient(db, actor, publicInput);
  await service.eraseClient(db, actor, unowned.clientId, unowned.clientId);
  const events = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.action, "client.erased"))
    .orderBy(auditEvents.id);
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({
    ...actor,
    organizationId,
    targetType: "client",
    targetId: client.clientId,
    outcome: "success",
  });
  expect(events[1]).toMatchObject({
    organizationId: null,
    targetId: unowned.clientId,
  });
});

test("client audit records allowlist security settings and omit raw JWK configuration", async () => {
  const client = await service.createClient(connection.db, actor, {
    clientId: "audit-key-material",
    name: "Audit keys",
    tokenEndpointAuthMethod: "private_key_jwt",
    grantTypes: ["authorization_code"],
    redirectUris: ["https://client.example/callback"],
    jwks: JSON.stringify({
      keys: [
        { kty: "RSA", n: "public", e: "AQAB", d: "sensitive-private-material" },
      ],
    }),
  });
  await service.updateClient(connection.db, actor, client.clientId, {
    jwks: JSON.stringify({
      keys: [
        {
          kty: "RSA",
          n: "public",
          e: "AQAB",
          d: "replacement-private-material",
        },
      ],
    }),
  });
  const rows = await connection.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.targetId, client.clientId));
  expect(JSON.stringify(rows)).not.toContain("sensitive-private-material");
  expect(JSON.stringify(rows)).not.toContain("replacement-private-material");
  expect(
    rows.find((row) => row.action === "client.created")!.data,
  ).toMatchObject({
    before: null,
    after: { hasJwks: true, hasClientSecret: false },
  });
  expect(
    rows.find((row) => row.action === "client.updated")!.data,
  ).toMatchObject({
    requestedFields: ["jwks"],
    before: { authorizationVersion: 1 },
    after: { authorizationVersion: 2 },
  });
});
