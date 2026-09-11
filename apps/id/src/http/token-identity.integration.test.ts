import { approveMachineCapability } from "../__tests__/capabilities.ts";
import { platformWriteService } from "../__tests__/platform-context.ts";
import { inPlatformWrite } from "../__tests__/platform-context.ts";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  decodeJwt,
  decodeProtectedHeader,
  generateKeyPair,
  SignJWT,
} from "jose";
import { testEnvironment } from "../__tests__/support.ts";
import { createApp } from "../app.ts";
import { createAuth } from "../auth.ts";
import { createDatabase, type DatabaseConnection } from "../db/client.ts";
import { createOrganization } from "../__tests__/organization-queries.ts";
import {
  organizationCapabilities,
  oauthClients,
  oauthResources,
} from "../db/schema/index.ts";
import { machineIdentitySchema } from "../auth/machine-identity.ts";
import * as clientsImplementation from "../services/clients.ts";
const clients = {
  ...clientsImplementation,
  createClient: platformWriteService(clientsImplementation.createClient),
  disableClient: platformWriteService(clientsImplementation.disableClient),
  enableClient: platformWriteService(clientsImplementation.enableClient),
  rotateSecret: platformWriteService(clientsImplementation.rotateSecret),
  setOwner: platformWriteService(clientsImplementation.setOwner),
  linkResource: platformWriteService(clientsImplementation.linkResource),
  unlinkResource: platformWriteService(clientsImplementation.unlinkResource),
};
import { createResource } from "../__tests__/resource-queries.ts";
import { createId } from "../lib/id.ts";

let connection: DatabaseConnection;
const environment = testEnvironment();
const actor = {
  actorType: "system" as const,
  actorId: "identity-test",
  requestId: "identity-test",
};
let orgId: string;
let otherOrgId: string;
let client: Awaited<ReturnType<typeof clients.createClient>>;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  connection = createDatabase(environment);
});
afterAll(async () => connection.close());
beforeEach(async () => {
  const db = connection.db;
  await db.execute(
    sql`truncate users, organizations, oauth_clients, oauth_resources, audit_events cascade`,
  );
  orgId = (await createOrganization(db, { slug: "tenant-a", name: "A" })).id;
  otherOrgId = (await createOrganization(db, { slug: "tenant-b", name: "B" }))
    .id;
  await createResource(db, {
    identifier: environment.adminResourceIdentifier,
    name: "Admin",
    allowedScopes: ["org:read"],
    accessTokenTtl: 600,
  });
  client = await clients.createClient(db, actor, {
    clientId: "identity-client",
    name: "Identity",
    organizationId: orgId,
    tokenEndpointAuthMethod: "client_secret_basic",
    grantTypes: ["client_credentials"],
    redirectUris: [],
    clientCredentialsScopes: ["org:read"],
  });
  await clients.linkResource(
    db,
    actor,
    client.clientId,
    environment.adminResourceIdentifier,
  );
  await approveMachineCapability(db, {
    organizationId: orgId,
    clientId: client.clientId,
    resource: environment.adminResourceIdentifier,
    scopes: ["org:read"],
  });
  app = createApp({ auth: createAuth(db, environment), db, environment });
});
async function mint() {
  const response = await app.request("/auth/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      resource: environment.adminResourceIdentifier,
      scope: "org:read",
    }),
  });
  expect(response.status).toBe(200);
  return (await response.json()).access_token as string;
}
function me(token: string) {
  return app.request("/api/admin/v1/me", {
    headers: { Authorization: `bearer ${token}` },
  });
}

test("machine JWT binds immutable client instance, owner and authorization version", async () => {
  const token = await mint();
  expect(decodeJwt(token)).toMatchObject({
    client_instance: client.id,
    organization_id: orgId,
    authorization_version: 1,
    subject_type: "client",
  });
  expect((await me(token)).status).toBe(200);
});
test("resource custom claims cannot replace machine identity claims", async () => {
  for (const claim of Object.keys(machineIdentitySchema.shape)) {
    await expect(
      connection.db
        .update(oauthResources)
        .set({
          customClaims: { [claim]: "forged" },
        })
        .execute(),
    ).rejects.toThrow();
  }
  await connection.db.update(oauthResources).set({
    customClaims: { department: "engineering" },
  });
  expect(decodeJwt(await mint())).toMatchObject({
    department: "engineering",
    organization_id: orgId,
  });
});
test("an out-of-band ownership update is rejected and leaves the token in its original tenant", async () => {
  const token = await mint();
  await expect(
    connection.db
      .update(oauthClients)
      .set({ organizationId: otherOrgId })
      .where(eq(oauthClients.clientId, client.clientId))
      .execute(),
  ).rejects.toThrow();
  const response = await me(token);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    principal: { organizationId: orgId },
  });
});
test("administration cannot transfer or detach client ownership", async () => {
  const token = await mint();
  for (const owner of [otherOrgId, null]) {
    await expect(
      clients.setOwner(connection.db, actor, client.clientId, owner),
    ).rejects.toMatchObject({ status: 409, code: "ownership_conflict" });
  }
  expect(
    await clients.setOwner(connection.db, actor, client.clientId, orgId),
  ).toMatchObject({ organizationId: orgId });
  expect((await me(token)).status).toBe(200);
});
test("a deleted client identifier cannot be recreated and its old token is rejected", async () => {
  const token = await mint();
  const [row] = await connection.db
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.clientId, client.clientId));
  await connection.db
    .delete(organizationCapabilities)
    .where(eq(organizationCapabilities.clientId, client.clientId));
  await connection.db
    .update(oauthClients)
    .set({ deletedAt: new Date(), disabled: true, clientSecret: null })
    .where(eq(oauthClients.clientId, client.clientId));
  await expect(
    connection.db
      .insert(oauthClients)
      .values({ ...row!, id: createId() })
      .execute(),
  ).rejects.toThrow();
  expect((await me(token)).status).toBe(401);
});
test("disable followed by enable does not revive old tokens", async () => {
  const token = await mint();
  await clients.disableClient(connection.db, actor, client.clientId);
  await clients.enableClient(connection.db, actor, client.clientId);
  expect((await me(token)).status).toBe(401);
  expect((await me(await mint())).status).toBe(200);
});
test("secret rotation invalidates tokens from the previous credential version", async () => {
  const token = await mint();
  const rotated = await clients.rotateSecret(
    connection.db,
    actor,
    client.clientId,
  );
  expect((await me(token)).status).toBe(401);
  client.clientSecret = rotated.clientSecret;
  expect((await me(await mint())).status).toBe(200);
});
test("admin consumption rechecks the client-resource link and current resource policy", async () => {
  const token = await mint();
  await clients.unlinkResource(
    connection.db,
    actor,
    client.clientId,
    environment.adminResourceIdentifier,
  );
  expect((await me(token)).status).toBe(401);
  await clients.linkResource(
    connection.db,
    actor,
    client.clientId,
    environment.adminResourceIdentifier,
  );
  await connection.db.update(oauthResources).set({ disabled: true });
  expect((await me(token)).status).toBe(401);
  await connection.db
    .update(oauthResources)
    .set({ disabled: false, allowedScopes: [] });
  const response = await me(token);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ grants: [{ scopes: [] }] });
});

test("organisation disable and re-enable never revive the old machine token", async () => {
  const token = await mint();
  const { disableOrganization, enableOrganization } =
    await import("../services/organizations.ts");
  await inPlatformWrite(connection.db, (context) =>
    disableOrganization(context, orgId),
  );
  await inPlatformWrite(connection.db, (context) =>
    enableOrganization(context, orgId),
  );
  expect((await me(token)).status).toBe(401);
  expect((await me(await mint())).status).toBe(200);
});

test("online admin consumption drops scopes when the machine capability is disabled or removed", async () => {
  const token = await mint();
  const [capability] = await connection.db
    .select()
    .from(organizationCapabilities)
    .where(eq(organizationCapabilities.clientId, client.clientId));
  await connection.db
    .update(organizationCapabilities)
    .set({ status: "disabled" })
    .where(eq(organizationCapabilities.id, capability!.id));
  const denied = await me(token);
  expect(denied.status).toBe(200);
  expect((await denied.json()).grants[0].scopes).toEqual([]);
  await connection.db
    .delete(organizationCapabilities)
    .where(eq(organizationCapabilities.id, capability!.id));
  const removed = await me(token);
  expect((await removed.json()).grants[0].scopes).toEqual([]);
});

for (const attack of ["none", "HS256", "foreign-key"] as const)
  test(`admin rejects ${attack} bearer signatures`, async () => {
    const valid = await mint();
    const payload = decodeJwt(valid);
    const { kid } = decodeProtectedHeader(valid);
    const token =
      attack === "none"
        ? `${Buffer.from(JSON.stringify({ alg: "none", typ: "at+jwt", kid })).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.`
        : await new SignJWT(payload)
            .setProtectedHeader({
              alg: attack === "HS256" ? "HS256" : "EdDSA",
              typ: "at+jwt",
              kid,
            })
            .sign(
              attack === "HS256"
                ? new TextEncoder().encode(environment.betterAuthSecret)
                : (await generateKeyPair("EdDSA")).privateKey,
            );
    const response = await me(token);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "invalid_token" });
  });
