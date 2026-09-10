import { afterBrokerRead } from "../../__tests__/after-broker-read.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import {
  adminOperations,
  entitlements,
  members,
} from "../../db/schema/index.ts";
import { createId } from "../../lib/id.ts";
let fixture: AdminFixture;
beforeAll(async () => {
  fixture = await createAdminFixture();
});
afterAll(async () => fixture?.close());
async function receipt(actorInstance: string, authorityScope: string) {
  const id = createId();
  await fixture.db.insert(adminOperations).values({
    id,
    actorInstance,
    authorityScope,
    name: "test.own",
    keyDigest: createId(),
    fingerprint: "private-input",
    outcome: "applied",
    statusCode: 204,
    resultReference: { type: "user", id: createId() },
  });
  return id;
}
const path = (id: string) => `/api/admin/v1/me/operations/${id}`;
const read = (id: string, kind: Parameters<AdminFixture["headers"]>[0]) =>
  fixture.app.request(path(id), { headers: fixture.headers(kind) });
test("own receipt reads support users-only authority and never expose other actors or private data", async () => {
  const actor = fixture.principals.tenantUsersOnly;
  const id = await receipt(
    `user:${actor.userId}`,
    `tenant:${fixture.tenant.organizationId}`,
  );
  const response = await read(id, "tenantUsersOnly");
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const body = await response.json();
  expect(body).toMatchObject({ id, replay: "reference" });
  expect(Object.keys(body).sort()).toEqual([
    "committedAt",
    "id",
    "name",
    "outcome",
    "replay",
    "replayExpiresAt",
    "resultReference",
    "statusCode",
  ]);
  expect(JSON.stringify(body)).not.toContain("private-input");
  for (const kind of ["platformAdmin", "tenantReader", "outsider"] as const)
    expect((await read(id, kind)).status).toBe(404);
  expect((await fixture.app.request(path(id))).status).toBe(401);
  const hostile = fixture.headers("tenantUsersOnly");
  hostile.set("Origin", "https://evil.example");
  expect(
    (await fixture.app.request(path(id), { headers: hostile })).status,
  ).toBe(403);
  expect((await read("bad-id", "tenantUsersOnly")).status).toBe(400);
  expect((await read(createId(), "tenantUsersOnly")).status).toBe(404);
  const foreign = await receipt(
    `user:${actor.userId}`,
    `tenant:${fixture.outsider.organizationId}`,
  );
  expect((await read(foreign, "tenantUsersOnly")).status).toBe(403);
  const platform = await receipt(`user:${actor.userId}`, "platform");
  expect((await read(platform, "tenantUsersOnly")).status).toBe(403);
  for (const scope of ["tenant:invalid", "legacy-unknown"])
    expect(
      (
        await read(
          await receipt(`user:${actor.userId}`, scope),
          "tenantUsersOnly",
        )
      ).status,
    ).toBe(404);
  const noGrant = await receipt(
    `user:${fixture.principals.noGrant.userId}`,
    `tenant:${fixture.tenant.organizationId}`,
  );
  expect((await read(noGrant, "noGrant")).status).toBe(403);
});
test("own receipt reads recheck tenant membership inside the read transaction", async () => {
  const actor = fixture.principals.tenantUsersOnly;
  const id = await receipt(
    `user:${actor.userId}`,
    `tenant:${fixture.tenant.organizationId}`,
  );
  const original = fixture.db.transaction.bind(fixture.db);
  fixture.db.transaction = afterBrokerRead(original, (async (
    ...args: Parameters<typeof original>
  ) => {
    fixture.db.transaction = original;
    await fixture.db
      .update(members)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(eq(members.id, actor.memberId));
    return original(...args);
  }) as typeof original);
  try {
    expect((await read(id, "tenantUsersOnly")).status).toBe(403);
  } finally {
    fixture.db.transaction = original;
    await fixture.db
      .update(members)
      .set({ status: "active", revokedAt: null })
      .where(eq(members.id, actor.memberId));
  }
});
test("platform users and write scopes can inspect own receipts without gaining audit access", async () => {
  const actor = fixture.principals.platformReader;
  const id = await receipt(`user:${actor.userId}`, "platform");
  const predicate = eq(entitlements.memberId, actor.memberId);
  try {
    for (const scope of ["platform:users", "platform:write"]) {
      await fixture.db
        .update(entitlements)
        .set({ scopes: [scope] })
        .where(predicate);
      expect((await read(id, "platformReader")).status).toBe(200);
      expect(
        (
          await fixture.app.request(`/api/admin/v1/operations/${id}`, {
            headers: fixture.headers("platformReader"),
          })
        ).status,
      ).toBe(403);
    }
  } finally {
    await fixture.db
      .update(entitlements)
      .set({ scopes: ["platform:read"] })
      .where(predicate);
  }
});
test("machine and root own-receipt identities come only from authenticated principals", async () => {
  const machine = {
    bearer: await fixture.mintMachineToken(["platform:users"]),
  };
  const id = await receipt(
    `client:${fixture.platform.client.clientId}`,
    "platform",
  );
  expect((await read(id, machine)).status).toBe(200);
  const foreign = await receipt(`client:${createId()}`, "platform");
  expect((await read(foreign, machine)).status).toBe(404);
  const root = await receipt("system:root", "platform");
  const response = await fixture.app.request(path(root), {
    headers: fixture.headers("root"),
  });
  expect(response.status).toBe(200);
});
