import { expectReceipt } from "../../__tests__/operation-receipt.ts";
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
  fixture = await createAdminFixture(
    { databasePoolMax: 2 },
    { restrictedRole: true },
  );
});
afterAll(async () => fixture?.close());

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

test("rotation replay returns its receipt without revoking grants established afterwards", async () => {
  const f = await createAdminFixture(
    { databasePoolMax: 1 },
    { restrictedRole: true },
  );
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
