import { expectReceipt } from "../../__tests__/operation-receipt.ts";
import { afterBrokerRead } from "../../__tests__/after-broker-read.ts";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import {
  adminOperations,
  auditEvents,
  entitlements,
  members,
  oauthResources,
} from "../../db/schema/index.ts";
import { createId } from "../../lib/id.ts";
let fixture: AdminFixture;
const resource = "https://entitlement-replay.example.com";
beforeAll(async () => {
  fixture = await createAdminFixture();
  await fixture.db.insert(oauthResources).values({
    id: createId(),
    identifier: resource,
    name: "Replay",
    allowedScopes: ["read", "write"],
  });
});
afterAll(async () => fixture?.close());
beforeEach(async () => {
  await fixture.db
    .delete(entitlements)
    .where(eq(entitlements.resource, resource));
});
const tags = new Map<string, string>();
async function command(
  key: string,
  path = "",
  method = "POST",
  body?: unknown,
) {
  const headers = fixture.headers("platformAdmin");
  headers.set("Idempotency-Key", key);
  if (method === "PATCH") {
    if (!tags.has(key)) {
      const current = await fixture.app.request(
        `/api/admin/v1/organizations/${fixture.tenant.organizationId}/entitlements${path}`,
        { headers },
      );
      tags.set(key, current.headers.get("ETag")!);
    }
    headers.set("If-Match", tags.get(key)!);
  }
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return fixture.app.request(
    `/api/admin/v1/organizations/${fixture.tenant.organizationId}/entitlements${path}`,
    {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
}
const input = { resource, scopes: ["write", "read", "read"] };
test("all entitlement commands return receipts and one audit fact", async () => {
  const first = await command("create", "", "POST", input);
  expect(first.status).toBe(201);
  const created = await first.json();
  expect(created.scopes).toEqual(["read", "write"]);
  const steps: [string, string, string, unknown, number][] = [
    ["create", "", "POST", { resource, scopes: ["read", "write"] }, 201],
    [
      "update",
      `/${created.id}`,
      "PATCH",
      { scopes: ["write"], validUntil: "2100-01-01T00:00:00Z" },
      200,
    ],
    ["disable", `/${created.id}/disable`, "POST", undefined, 200],
    ["enable", `/${created.id}/enable`, "POST", undefined, 200],
    ["remove", `/${created.id}`, "DELETE", undefined, 204],
  ];
  const saved: {
    step: (typeof steps)[number];
    response: Response;
  }[] = [];
  for (const step of steps) {
    const response = await command(
      ...(step.slice(0, 4) as [string, string, string, unknown]),
    );
    expect(response.status).toBe(step[4]);
    saved.push({ step, response });
  }
  for (const { step, response } of saved) {
    const replay = await command(
      ...(step.slice(0, 4) as [string, string, string, unknown]),
    );
    expect(replay.status).toBe(response.status);
    await expectReceipt(fixture.db, replay);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(replay.headers.get("Operation-Id")).toBe(
      response.headers.get("Operation-Id"),
    );
    expect(
      await fixture.db
        .select()
        .from(auditEvents)
        .where(
          eq(auditEvents.operationId, replay.headers.get("Operation-Id")!),
        ),
    ).toHaveLength(1);
  }
  expect(
    (await command("create", "", "POST", { resource, scopes: ["read"] }))
      .status,
  ).toBe(409);
  expect(
    (await command("update", `/${created.id}`, "PATCH", { scopes: ["read"] }))
      .status,
  ).toBe(409);
});
test("new-key entitlement noops preserve stored state and record noop outcomes", async () => {
  const row = await (await command("noop-create", "", "POST", input)).json();
  for (const [path, method, body] of [
    [`/${row.id}`, "PATCH", input],
    [`/${row.id}/enable`, "POST", undefined],
  ] as const) {
    const response = await command(
      `noop-${method}`,
      path,
      method,
      body === undefined ? undefined : { scopes: body.scopes },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(row);
    const [operation] = await fixture.db
      .select()
      .from(adminOperations)
      .where(eq(adminOperations.id, response.headers.get("Operation-Id")!));
    expect(operation?.outcome).toBe("noop");
  }
});
test("entitlement replay requires current platform authority after middleware", async () => {
  const first = await command("authority", "", "POST", input);
  expect(first.status).toBe(201);
  const original = fixture.db.transaction.bind(fixture.db);
  const actor = fixture.principals.platformAdmin;
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
    expect((await command("authority", "", "POST", input)).status).toBe(403);
  } finally {
    fixture.db.transaction = original;
    await fixture.db
      .update(members)
      .set({ status: "active", revokedAt: null })
      .where(eq(members.id, actor.memberId));
  }
  expect(
    await fixture.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.operationId, first.headers.get("Operation-Id")!)),
  ).toHaveLength(1);
});
