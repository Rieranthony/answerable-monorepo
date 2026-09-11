import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { afterBrokerRead } from "../../__tests__/after-broker-read.ts";
import { expectReceipt } from "../../__tests__/operation-receipt.ts";
import {
  adminOperations,
  auditEvents,
  members,
  users,
  oauthResources,
} from "../../db/schema/index.ts";
import { createId } from "../../lib/id.ts";

let fixture: AdminFixture;
beforeAll(async () => {
  fixture = await createAdminFixture({ databasePoolMax: 2 });
});
afterAll(async () => fixture?.close());

const families = [
  "client",
  "resource",
  "user",
  "session",
  "entitlement",
] as const;
async function prepare(family: (typeof families)[number]) {
  const id = createId();
  let path: string;
  let body: unknown;
  let status = 200;
  switch (family) {
    case "client":
      path = "/clients";
      body = {
        clientId: id,
        name: "Receipt",
        organizationId: fixture.tenant.organizationId,
        tokenEndpointAuthMethod: "client_secret_basic",
        grantTypes: ["client_credentials"],
        clientCredentialsScopes: ["read"],
      };
      status = 201;
      break;
    case "resource":
      path = "/resources";
      body = {
        identifier: `https://${id}.example/resource`,
        name: "Receipt",
        allowedScopes: ["read"],
      };
      status = 201;
      break;
    case "entitlement":
      path = `/organizations/${fixture.tenant.organizationId}/entitlements`;
      await fixture.db.insert(oauthResources).values({
        id,
        identifier: `https://${id}.example/resource`,
        name: "Receipt",
        allowedScopes: ["read"],
      });
      body = {
        resource: `https://${id}.example/resource`,
        scopes: ["read"],
        validUntil: "2100-01-01T00:00:00Z",
      };
      status = 201;
      break;
    default:
      await fixture.db.insert(users).values({
        id,
        email: `${id}@receipt.example`,
        name: "Receipt",
        status: "active",
      });
      path = `/users/${id}/${family === "user" ? "disable" : "sessions"}`;
  }
  const key = createId();
  const send = async (different = false) => {
    const headers = fixture.headers("platformAdmin");
    headers.set("Idempotency-Key", key);
    if (body !== undefined) headers.set("Content-Type", "application/json");
    return fixture.app.request(
      `/api/admin/v1${different && body === undefined ? path.replace(id, createId()) : path}`,
      {
        method: family === "session" ? "DELETE" : "POST",
        headers,
        body:
          body === undefined
            ? undefined
            : JSON.stringify(
                different
                  ? {
                      ...(body as object),
                      ...(family === "entitlement"
                        ? { validUntil: "2099-01-01T00:00:00Z" }
                        : { name: "Different" }),
                    }
                  : body,
              ),
      },
    );
  };
  const reservations = () =>
    fixture.db
      .select()
      .from(adminOperations)
      .where(
        and(
          eq(
            adminOperations.actorInstance,
            `user:${fixture.principals.platformAdmin.userId}`,
          ),
          eq(
            adminOperations.keyDigest,
            createHash("sha256").update(key).digest("hex"),
          ),
        ),
      );
  return { send, status, reservations };
}

test.each([...families])(
  "%s: matching retries return a receipt, changed input conflicts and current authority is required",
  async (family) => {
    const command = await prepare(family);
    const first = await command.send();
    expect(first.status).toBe(command.status);
    const operationId = first.headers.get("Operation-Id")!;
    const evidence = () =>
      fixture.db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.operationId, operationId));
    const before = await evidence();
    await expectReceipt(fixture.db, await command.send());
    expect(await evidence()).toEqual(before);
    expect(await command.reservations()).toHaveLength(1);
    const changed = await command.send(true);
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({
      code: "idempotency_key_reused",
    });
    const original = fixture.db.transaction.bind(fixture.db);
    fixture.db.transaction = afterBrokerRead(original, (async (
      ...args: Parameters<typeof original>
    ) => {
      fixture.db.transaction = original;
      await fixture.db
        .update(members)
        .set({ status: "revoked", revokedAt: new Date() })
        .where(eq(members.id, fixture.principals.platformAdmin.memberId));
      return original(...args);
    }) as typeof original);
    try {
      expect((await command.send()).status).toBe(403);
    } finally {
      fixture.db.transaction = original;
      await fixture.db
        .update(members)
        .set({ status: "active", revokedAt: null })
        .where(eq(members.id, fixture.principals.platformAdmin.memberId));
    }
    expect(await evidence()).toEqual(before);
  },
);

test.each([...families])(
  "%s: overlapping same-key commands commit once and return one 409",
  async (family) => {
    const command = await prepare(family);
    const ready = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = fixture.db.transaction.bind(fixture.db);
    fixture.db.transaction = afterBrokerRead(original, (async (
      callback: Parameters<typeof original>[0],
    ) => {
      fixture.db.transaction = original;
      return original(async (tx) => {
        const result = await callback(tx);
        ready.resolve();
        await release.promise;
        return result;
      });
    }) as typeof original);
    const first = command.send();
    try {
      await Promise.race([
        ready.promise,
        first.then(() => {
          throw new Error("Command did not reach commit barrier");
        }),
      ]);
      const second = await command.send();
      expect(second.status).toBe(409);
      expect(await second.json()).toMatchObject({
        code: "operation_in_progress",
      });
    } finally {
      fixture.db.transaction = original;
      release.resolve();
    }
    expect((await first).status).toBe(command.status);
    expect(await command.reservations()).toHaveLength(1);
    await expectReceipt(fixture.db, await command.send());
  },
);

test.each([...families])(
  "%s: failed commands leave no receipt and the same key remains usable",
  async (family) => {
    const command = await prepare(family);
    await fixture.db.execute(
      sql`alter table audit_events add constraint receipt_fault check (operation_id is null) not valid`,
    );
    try {
      expect((await command.send()).status).toBe(400);
      expect(await command.reservations()).toEqual([]);
    } finally {
      await fixture.db.execute(
        sql`alter table audit_events drop constraint receipt_fault`,
      );
    }
    expect((await command.send()).status).toBe(command.status);
    expect(await command.reservations()).toHaveLength(1);
    await expectReceipt(fixture.db, await command.send());
  },
);
