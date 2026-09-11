import { expectReceipt } from "../../__tests__/operation-receipt.ts";
import { z } from "zod";
import { clientSchema } from "./clients.ts";
import { createId } from "../../lib/id.ts";
import { authorizeCommand } from "../../services/command-authority.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import {
  auditEvents,
  grantContexts,
  oauthClients,
  sessions,
} from "../../db/schema/index.ts";
let fixture: AdminFixture;
beforeAll(async () => {
  fixture = await createAdminFixture({ databasePoolMax: 2 });
});
afterAll(async () => fixture?.close());
function request(path: string, key: string, body?: unknown) {
  const headers = fixture.headers("platformAdmin");
  headers.set("Idempotency-Key", key);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return fixture.app.request(`/api/admin/v1/clients${path}`, {
    method: "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
test("client creation and rotation return receipts without repeating their effects", async () => {
  const input = {
    clientId: "replay-client",
    name: "Replay client",
    organizationId: fixture.tenant.organizationId,
    tokenEndpointAuthMethod: "client_secret_basic",
    grantTypes: ["client_credentials"],
    clientCredentialsScopes: ["tool:write", "tool:read"],
  };
  const first = await request("", "create-key", input);
  expect(first.status).toBe(201);
  expect(first.headers.get("access-control-expose-headers")).toContain(
    "Operation-Id",
  );
  expect(first.headers.get("Cache-Control")).toBe("no-store");
  const created = await first.json();
  expect(
    clientSchema
      .extend({ clientSecret: z.string() })
      .strict()
      .safeParse(created).success,
  ).toBe(true);
  const second = await request("", "create-key", {
    ...input,
    redirectUris: [],
    clientCredentialsScopes: ["tool:read", "tool:write", "tool:read"],
  });
  expect(second.status).toBe(201);
  await expectReceipt(fixture.db, second);
  expect(second.headers.get("Idempotency-Replayed")).toBe("true");
  expect(second.headers.get("Operation-Id")).toBe(
    first.headers.get("Operation-Id"),
  );
  const rotated = await request(
    `/${created.clientId}/rotate-secret`,
    "rotate-key",
  );
  expect(rotated.status).toBe(200);
  const secret = await rotated.json();
  const [before] = await fixture.db
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.clientId, created.clientId));
  const recovered = await request(
    `/${created.clientId}/rotate-secret`,
    "rotate-key",
  );
  await expectReceipt(fixture.db, recovered);
  const [after] = await fixture.db
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.clientId, created.clientId));
  expect(after!.authorizationVersion).toBe(before!.authorizationVersion);
  expect(after!.clientSecret).toBe(before!.clientSecret);
  const events = await fixture.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.targetId, created.clientId));
  expect(
    events.filter((event) => event.action === "client.created"),
  ).toHaveLength(1);
  expect(
    events.filter((event) => event.action === "client.secret_rotated"),
  ).toHaveLength(1);
  expect(JSON.stringify(events)).not.toContain(secret.clientSecret);
  expect(
    events.every(
      (event) => event.organizationId === fixture.tenant.organizationId,
    ),
  ).toBe(true);
  expect(
    events.find((event) => event.action === "client.secret_rotated")!.data,
  ).toMatchObject({
    after: { authorizationVersion: before!.authorizationVersion },
    effects: { credentialChanged: true },
  });
  const trace = await fixture.app.request(
    `/api/admin/v1/audit-events?operationId=${first.headers.get("Operation-Id")}`,
    { headers: fixture.headers("platformAdmin") },
  );
  expect(trace.status).toBe(200);
  const traced = await trace.json();
  expect(traced.items).toHaveLength(1);
  expect(traced.items[0]).toMatchObject({
    action: "client.created",
    schemaVersion: 1,
  });
  expect(
    events.find((event) => event.action === "client.created")!.operationId,
  ).toBe(first.headers.get("Operation-Id"));
  expect(
    events.find((event) => event.action === "client.secret_rotated")!
      .operationId,
  ).toBe(rotated.headers.get("Operation-Id"));
});

test("key errors cannot repeat a rotation", async () => {
  const path = "/replay-client/rotate-secret";
  const invalidHeaders = fixture.headers("platformAdmin");
  invalidHeaders.delete("Idempotency-Key");
  expect(
    (
      await fixture.app.request(`/api/admin/v1/clients${path}`, {
        method: "POST",
        headers: invalidHeaders,
      })
    ).status,
  ).toBe(400);
  const different = await request(
    "/different-client/rotate-secret",
    "rotate-key",
  );
  expect(different.status).toBe(409);
  expect(await different.json()).toMatchObject({
    code: "idempotency_key_reused",
    retryable: false,
  });
});

test("transactional authority rejects stale admitted users, root and machine credentials", async () => {
  const principal = fixture.principals.platformAdmin;
  await expect(
    fixture.db.transaction((tx) =>
      authorizeCommand(
        tx,
        {
          type: "user",
          userId: principal.userId,
          sessionId: createId(),
          email: "ignored",
          grants: [],
        },
        fixture.environment,
        { platform: "platform:write" },
      ),
    ),
  ).rejects.toMatchObject({ code: "unauthenticated" });
  const reader = fixture.principals.platformReader;
  const [session] = await fixture.db
    .select()
    .from(sessions)
    .where(eq(sessions.userId, reader.userId));
  await expect(
    fixture.db.transaction((tx) =>
      authorizeCommand(
        tx,
        {
          type: "user",
          userId: reader.userId,
          sessionId: session!.id,
          email: "ignored",
          grants: [],
        },
        fixture.environment,
        { platform: "platform:write" },
      ),
    ),
  ).rejects.toMatchObject({ code: "insufficient_scope" });
  await expect(
    fixture.db.transaction((tx) =>
      authorizeCommand(
        tx,
        { type: "root", grants: [] },
        { ...fixture.environment, rootAdminBreakGlass: false },
        { platform: "platform:write" },
      ),
    ),
  ).rejects.toMatchObject({ code: "root_locked" });
  await expect(
    fixture.db.transaction((tx) =>
      authorizeCommand(
        tx,
        {
          type: "client",
          clientId: fixture.platform.client.clientId,
          organizationId: fixture.platform.organizationId,
          grants: [],
        },
        fixture.environment,
        { platform: "platform:write" },
      ),
    ),
  ).rejects.toMatchObject({ code: "invalid_token" });
});

test("deletion replay uses the retained operation, and a revoked session cannot recover it", async () => {
  await fixture.db
    .delete(oauthClients)
    .where(eq(oauthClients.clientId, "replay-client"));
  const input = {
    clientId: "replay-client",
    name: "Replay client",
    organizationId: fixture.tenant.organizationId,
    tokenEndpointAuthMethod: "client_secret_basic",
    grantTypes: ["client_credentials"],
    clientCredentialsScopes: ["tool:read", "tool:write"],
  };
  const replay = await request("", "create-key", input);
  expect(replay.status).toBe(201);
  await expectReceipt(fixture.db, replay);
  expect(
    await fixture.db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.clientId, "replay-client")),
  ).toHaveLength(0);
  await fixture.db
    .delete(sessions)
    .where(eq(sessions.userId, fixture.principals.platformAdmin.userId));
  expect((await request("", "create-key", input)).status).toBe(401);
});

test("rotation replay returns its receipt without revoking grants established afterwards", async () => {
  const f = await createAdminFixture({ databasePoolMax: 1 });
  try {
    const post = (path: string, key: string, body?: unknown) => {
      const headers = f.headers("platformAdmin");
      headers.set("Idempotency-Key", key);
      if (body !== undefined) headers.set("Content-Type", "application/json");
      return f.app.request(`/api/admin/v1/clients${path}`, {
        method: "POST",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    };
    const createdResponse = await post("", "context-client", {
      clientId: "rotation-context-client",
      name: "Rotation",
      organizationId: f.tenant.organizationId,
      tokenEndpointAuthMethod: "client_secret_basic",
      grantTypes: ["authorization_code", "refresh_token"],
      redirectUris: ["https://client.example/callback"],
      scopes: ["read"],
    });
    expect(createdResponse.status).toBe(201);
    const client = await createdResponse.json();
    const sessionId = createId(),
      authTime = new Date();
    const principal = f.principals.tenantAdmin;
    await f.db.insert(sessions).values({
      id: sessionId,
      userId: principal.userId,
      token: createId(),
      createdAt: authTime,
      expiresAt: new Date(Date.now() + 60000),
    });
    const grant = async () =>
      (
        await f.db
          .insert(grantContexts)
          .values({
            id: createId(),
            organizationId: f.tenant.organizationId,
            memberId: principal.memberId,
            userId: principal.userId,
            clientInstanceId: client.id,
            authenticationSessionId: sessionId,
            authTime,
            requestedScopes: ["read"],
            expiresAt: new Date(Date.now() + 60000),
          })
          .returning()
      )[0]!;
    const original = await grant();
    const first = await post(
      `/${client.clientId}/rotate-secret`,
      "rotate-context-key",
    );
    expect(first.status).toBe(200);
    expect((await first.json()).clientSecret).toBeString();
    const [old] = await f.db
      .select()
      .from(grantContexts)
      .where(eq(grantContexts.id, original.id));
    expect(old!.revokedAt).not.toBeNull();
    const fresh = await grant();
    const before = await f.db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.id, client.id));
    const replay = await post(
      `/${client.clientId}/rotate-secret`,
      "rotate-context-key",
    );
    expect(replay.status).toBe(200);
    await expectReceipt(f.db, replay);
    expect(
      await f.db
        .select()
        .from(grantContexts)
        .where(eq(grantContexts.id, fresh.id)),
    ).toEqual([fresh]);
    expect(
      await f.db
        .select()
        .from(oauthClients)
        .where(eq(oauthClients.id, client.id)),
    ).toEqual(before);
    const effects = await f.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.operationId, first.headers.get("Operation-Id")!));
    expect(effects).toHaveLength(2);
    expect(effects.map((row) => row.action).sort()).toEqual([
      "client.grants_revoked",
      "client.secret_rotated",
    ]);
    expect(
      effects.find((row) => row.action === "client.grants_revoked")!.data!
        .grantContexts,
    ).toEqual([
      {
        id: original.id,
        organizationId: original.organizationId,
        userId: original.userId,
      },
    ]);
  } finally {
    await f.close();
  }
});
