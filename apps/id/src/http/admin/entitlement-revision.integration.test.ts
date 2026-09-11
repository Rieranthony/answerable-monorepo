import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { createEntitlement } from "../../__tests__/entitlement-queries.ts";
import {
  entitlements,
  auditEvents,
  oauthResources,
} from "../../db/schema/index.ts";
let fixture: AdminFixture;
beforeAll(async () => {
  fixture = await createAdminFixture();
  await fixture.db.insert(oauthResources).values({
    id: Bun.randomUUIDv7(),
    identifier: "https://entitlement-revision.example.com",
    name: "Revision",
    allowedScopes: ["read", "write"],
  });
});
afterAll(async () => fixture?.close());
const path = (id: string) =>
  `/api/admin/v1/organizations/${fixture.tenant.organizationId}/entitlements/${id}`;
const read = (id: string) =>
  fixture.app.request(path(id), { headers: fixture.headers("platformAdmin") });
function patch(id: string, key: string, tag?: string, scopes = ["write"]) {
  const headers = fixture.headers("platformAdmin");
  headers.set("Idempotency-Key", key);
  headers.set("Content-Type", "application/json");
  if (tag !== undefined) headers.set("If-Match", tag);
  return fixture.app.request(path(id), {
    method: "PATCH",
    headers,
    body: JSON.stringify({ scopes }),
  });
}
test("entitlement revisions reject stale and recreated targets without breaking replay", async () => {
  const entitlement = await createEntitlement(fixture.db, {
    organizationId: fixture.tenant.organizationId,
    resource: "https://entitlement-revision.example.com",
    scopes: ["read"],
  });
  const first = await read(entitlement.id);
  const tag = first.headers.get("ETag")!;
  expect(tag).toBeString();
  const changed = await patch(entitlement.id, "first", tag);
  expect(changed.status).toBe(200);
  const saved = await changed.json();
  const nextTag = changed.headers.get("ETag")!;
  expect(saved.revision).toBe(entitlement.revision + 1);
  expect((await patch(entitlement.id, "stale", tag, ["read"])).status).toBe(
    412,
  );
  const replay = await patch(entitlement.id, "first", tag);
  expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
  expect(await replay.json()).toEqual(saved);
  expect(replay.headers.get("ETag")).toBe(nextTag);
  const noop = await patch(entitlement.id, "noop", nextTag);
  expect(noop.status).toBe(200);
  expect(await noop.json()).toEqual(saved);
  expect((await patch(entitlement.id, "missing")).status).toBe(200);
  expect((await patch(entitlement.id, "weak", `W/${nextTag}`)).status).toBe(
    400,
  );
  expect((await patch(entitlement.id, "first", nextTag)).status).toBe(409);
  await expect(
    fixture.db
      .update(entitlements)
      .set({ revision: 1 })
      .where(eq(entitlements.id, entitlement.id))
      .execute(),
  ).rejects.toThrow();
  expect((await read(entitlement.id)).headers.get("ETag")).toBe(nextTag);
  const [event] = await fixture.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.operationId, changed.headers.get("Operation-Id")!));
  expect(event?.data).toMatchObject({
    before: { revision: entitlement.revision },
    after: { revision: saved.revision },
  });
  for (const suffix of ["/disable", "/enable"]) {
    expect(
      (
        await fixture.app.request(path(entitlement.id) + suffix, {
          method: "POST",
          headers: fixture.headers("platformAdmin"),
        })
      ).status,
    ).toBe(200);
    expect(
      (await patch(entitlement.id, `stale-${suffix}`, nextTag)).status,
    ).toBe(412);
  }
  const beforeRaw = await read(entitlement.id);
  const rawTag = beforeRaw.headers.get("ETag")!;
  await fixture.db.execute(
    sql`update entitlements set valid_until = '2100-01-01T00:00:00Z' where id = ${entitlement.id}`,
  );
  const raw = await read(entitlement.id);
  expect(raw.headers.get("ETag")).not.toBe(rawTag);
  const current = raw.headers.get("ETag")!;
  const competing = await Promise.all([
    patch(entitlement.id, "race-a", current, ["read"]),
    patch(entitlement.id, "race-b", current, ["read", "write"]),
  ]);
  expect(competing.map((r) => r.status).sort()).toEqual([200, 412]);
  expect(
    (
      await fixture.app.request(path(entitlement.id), {
        method: "DELETE",
        headers: fixture.headers("platformAdmin"),
      })
    ).status,
  ).toBe(204);
  const replacement = await createEntitlement(fixture.db, {
    organizationId: fixture.tenant.organizationId,
    resource: entitlement.resource!,
    scopes: ["read"],
  });
  expect((await patch(replacement.id, "wrong-instance", tag)).status).toBe(412);
});
