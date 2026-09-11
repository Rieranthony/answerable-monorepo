import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { createGroup } from "../../__tests__/group-queries.ts";
import { groups, auditEvents } from "../../db/schema/index.ts";
let fixture: AdminFixture;
beforeAll(async () => {
  fixture = await createAdminFixture();
});
afterAll(async () => fixture?.close());
const path = (id: string) =>
  `/api/admin/v1/organizations/${fixture.tenant.organizationId}/groups/${id}`;
const read = (id: string) =>
  fixture.app.request(path(id), { headers: fixture.headers("platformAdmin") });
function patch(id: string, key: string, tag?: string, name = "Updated") {
  const headers = fixture.headers("platformAdmin");
  headers.set("Idempotency-Key", key);
  headers.set("Content-Type", "application/json");
  if (tag !== undefined) headers.set("If-Match", tag);
  return fixture.app.request(path(id), {
    method: "PATCH",
    headers,
    body: JSON.stringify({ name }),
  });
}
test("group revisions reject stale and recreated targets without breaking replay", async () => {
  const group = await createGroup(fixture.db, {
    organizationId: fixture.tenant.organizationId,
    slug: "group-revision",
    name: "Original",
  });
  const first = await read(group.id);
  const tag = first.headers.get("ETag")!;
  expect(tag).toBeString();
  const changed = await patch(group.id, "first", tag);
  expect(changed.status).toBe(200);
  const saved = await changed.json();
  const nextTag = changed.headers.get("ETag")!;
  expect(saved.revision).toBe(group.revision + 1);
  expect((await patch(group.id, "stale", tag, "Stale")).status).toBe(412);
  const replay = await patch(group.id, "first", tag);
  expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
  expect(await replay.json()).toEqual(saved);
  expect(replay.headers.get("ETag")).toBe(nextTag);
  const noop = await patch(group.id, "noop", nextTag);
  expect(noop.status).toBe(200);
  expect(await noop.json()).toEqual(saved);
  expect((await patch(group.id, "missing")).status).toBe(200);
  expect((await patch(group.id, "weak", `W/${nextTag}`)).status).toBe(400);
  expect((await patch(group.id, "first", nextTag)).status).toBe(409);
  await expect(
    fixture.db
      .update(groups)
      .set({ revision: 1 })
      .where(eq(groups.id, group.id))
      .execute(),
  ).rejects.toThrow();
  expect((await read(group.id)).headers.get("ETag")).toBe(nextTag);
  const [event] = await fixture.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.operationId, changed.headers.get("Operation-Id")!));
  expect(event?.data).toMatchObject({
    before: { revision: group.revision },
    after: { revision: saved.revision },
  });
  for (const suffix of ["/disable", "/enable"]) {
    expect(
      (
        await fixture.app.request(path(group.id) + suffix, {
          method: "POST",
          headers: fixture.headers("platformAdmin"),
        })
      ).status,
    ).toBe(200);
    expect((await patch(group.id, `stale-${suffix}`, nextTag)).status).toBe(
      412,
    );
  }
  const beforeRaw = await read(group.id);
  const rawTag = beforeRaw.headers.get("ETag")!;
  await fixture.db.execute(
    sql`update groups set external_id = 'directory-revision' where id = ${group.id}`,
  );
  const raw = await read(group.id);
  expect(raw.headers.get("ETag")).not.toBe(rawTag);
  const current = raw.headers.get("ETag")!;
  const competing = await Promise.all([
    patch(group.id, "race-a", current, "A"),
    patch(group.id, "race-b", current, "B"),
  ]);
  expect(competing.map((r) => r.status).sort()).toEqual([200, 412]);
  expect(
    (
      await fixture.app.request(`${path(group.id)}?confirm=${group.id}`, {
        method: "DELETE",
        headers: fixture.headers("platformAdmin"),
      })
    ).status,
  ).toBe(204);
  const replacement = await createGroup(fixture.db, {
    organizationId: fixture.tenant.organizationId,
    slug: `${group.slug}-replacement`,
    name: "Replacement",
  });
  expect((await patch(replacement.id, "wrong-instance", tag)).status).toBe(412);
});
