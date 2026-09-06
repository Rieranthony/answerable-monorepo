import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { testEnvironment } from "../__tests__/support.ts";
import { createDatabase, type DatabaseConnection } from "../db/client.ts";
import {
  auditEvents,
  oauthAccessTokens,
  oauthRefreshTokens,
  organizations,
  users,
} from "../db/schema/index.ts";
import * as queries from "../db/queries/oauth-clients.ts";
import { createResource } from "../db/queries/oauth-resources.ts";
import { createId } from "../lib/id.ts";
import type { Actor } from "./actor.ts";
import { hashClientSecret } from "./client-secrets.ts";
import * as service from "./clients.ts";

let connection: DatabaseConnection;
let organizationId: string;
const actor: Actor = {
  actorType: "user",
  actorId: createId(),
  requestId: "client-service-test",
};
const resource = "https://mcp.example.com";
const publicInput: service.CreateClientInput = {
  name: "Browser",
  tokenEndpointAuthMethod: "none",
  grantTypes: ["authorization_code"],
  redirectUris: ["https://app.example/callback"],
};
function machineInput(): service.CreateClientInput {
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
  expect(page).toEqual({ items: [read], nextCursor: null });
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
  await expect(
    service.enableClient(db, actor, created.clientId),
  ).rejects.toMatchObject({ status: 409, code: "client_already_active" });
  expect(
    await service.disableClient(db, actor, created.clientId),
  ).toMatchObject({ disabled: true });
  await expect(
    service.disableClient(db, actor, created.clientId),
  ).rejects.toMatchObject({ status: 409, code: "client_already_disabled" });
  for (const table of [oauthAccessTokens, oauthRefreshTokens])
    expect((await db.select().from(table))[0]?.revoked).toBeInstanceOf(Date);
  expect(await service.enableClient(db, actor, created.clientId)).toMatchObject(
    { disabled: false },
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
  expect(
    await service.setOwner(db, actor, created.clientId, otherId),
  ).toMatchObject({ organizationId: otherId });
  expect(
    await service.setOwner(db, actor, created.clientId, null),
  ).toMatchObject({ organizationId: null });
  const events = await db.select().from(auditEvents).orderBy(auditEvents.id);
  expect(events.map((e) => e.action)).toEqual([
    "client.created",
    "client.updated",
    "client.secret_rotated",
    "client.disabled",
    "client.enabled",
    "client.resource_linked",
    "client.resource_linked",
    "client.resource_unlinked",
    "client.owner_changed",
    "client.owner_changed",
  ]);
  for (const event of events)
    expect(event).toMatchObject({
      ...actor,
      targetType: "client",
      targetId: created.clientId,
      outcome: "success",
    });
  expect(events[1]?.data).toEqual({ changes: patch });
  expect(events[3]?.data).toEqual({ accessTokens: 1, refreshTokens: 1 });
  expect(events[8]?.data).toEqual({ from: organizationId, to: otherId });
  expect(events[9]?.data).toEqual({ from: otherId, to: null });
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
  const invalid: service.CreateClientInput[] = [
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
  await service.setOwner(db, actor, machine.clientId, null);
  await expect(
    service.updateClient(db, actor, machine.clientId, { name: "Unowned" }),
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
  ).rejects.toMatchObject({ status: 404, code: "not_found" });
  await expect(
    service.linkResource(db, actor, client.clientId, "https://missing.example"),
  ).rejects.toMatchObject({ status: 404, code: "not_found" });
  await expect(
    service.unlinkResource(db, actor, client.clientId, resource),
  ).rejects.toMatchObject({ status: 404, code: "not_found" });
  expect(await db.select().from(auditEvents)).toHaveLength(1);
});
test("audit failures roll back client writes, secrets, ownership, links and token revocation", async () => {
  const db = connection.db;
  const bad = { ...actor, requestId: "\0" };
  await expect(service.createClient(db, bad, machineInput())).rejects.toThrow();
  expect(await queries.findClient(db, "machine")).toBeNull();
  const client = await service.createClient(db, actor, machineInput());
  const tokenId = createId();
  await db.insert(oauthAccessTokens).values({
    id: tokenId,
    clientId: client.clientId,
    scopes: [],
    expiresAt: new Date(Date.now() + 60000),
  });
  for (const run of [
    () => service.updateClient(db, bad, client.clientId, { name: "Failed" }),
    () => service.rotateSecret(db, bad, client.clientId),
    () => service.setOwner(db, bad, client.clientId, null),
    () => service.linkResource(db, bad, client.clientId, resource),
    () => service.disableClient(db, bad, client.clientId),
  ])
    await expect(run()).rejects.toThrow();
  expect(await queries.findClient(db, client.clientId)).toMatchObject({
    name: "Machine",
    disabled: false,
    organizationId,
    clientSecret: hashClientSecret(client.clientSecret!),
  });
  expect(
    (
      await db
        .select()
        .from(oauthAccessTokens)
        .where(eq(oauthAccessTokens.id, tokenId))
    )[0]?.revoked,
  ).toBeNull();
  expect(await queries.listClientResources(db, client.clientId)).toHaveLength(
    0,
  );
  await service.linkResource(db, actor, client.clientId, resource);
  await expect(
    service.unlinkResource(db, bad, client.clientId, resource),
  ).rejects.toThrow();
  expect(await queries.listClientResources(db, client.clientId)).toHaveLength(
    1,
  );
  await service.disableClient(db, actor, client.clientId);
  await expect(
    service.enableClient(db, bad, client.clientId),
  ).rejects.toThrow();
  expect(await service.getClient(db, client.clientId)).toMatchObject({
    disabled: true,
  });
  expect(await db.select().from(auditEvents)).toHaveLength(3);
});
