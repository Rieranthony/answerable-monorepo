import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { organizations, auditEvents } from "../../db/schema/index.ts";
let fixture: AdminFixture;
beforeAll(async () => {
  fixture = await createAdminFixture();
});
afterAll(async () => fixture?.close());
const path = () =>
  `/api/admin/v1/organizations/${fixture.tenant.organizationId}`;
const read = () =>
  fixture.app.request(path(), { headers: fixture.headers("platformAdmin") });
function patch(key: string, tag?: string, name = "Revised tenant") {
  const headers = fixture.headers("platformAdmin");
  headers.set("Idempotency-Key", key);
  headers.set("Content-Type", "application/json");
  if (tag !== undefined) headers.set("If-Match", tag);
  return fixture.app.request(path(), {
    method: "PATCH",
    headers,
    body: JSON.stringify({ name }),
  });
}
test("organisation revision rejects stale edits while replay preserves its original result", async () => {
  const initial = await read();
  const tag = initial.headers.get("ETag")!;
  expect(tag).toBeString();
  const before = await initial.json();
  const changed = await patch("org-revision-first", tag);
  expect(changed.status).toBe(200);
  const saved = await changed.json();
  expect(saved.revision).toBe(before.revision + 1);
  const stale = await patch("org-revision-stale", tag, "Stale overwrite");
  expect(stale.status).toBe(412);
  expect(await stale.json()).toMatchObject({ code: "revision_mismatch" });
  const currentTag = changed.headers.get("ETag")!;
  expect((await read()).headers.get("ETag")).toBe(currentTag);
  const noop = await patch("org-revision-noop", currentTag);
  expect(noop.status).toBe(200);
  expect(await noop.json()).toEqual(saved);
  expect(noop.headers.get("ETag")).toBe(currentTag);
  const replay = await patch("org-revision-first", tag);
  expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
  expect(replay.headers.get("ETag")).toBe(currentTag);
  expect(await replay.json()).toEqual(saved);
  expect((await patch("org-revision-first", currentTag)).status).toBe(409);
  expect((await patch("org-revision-missing")).status).toBe(200);
  expect((await patch("org-revision-weak", `W/${currentTag}`)).status).toBe(
    400,
  );
  expect(
    (await patch("org-revision-other", `"${crypto.randomUUID()}:1"`)).status,
  ).toBe(412);
  const events = await fixture.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.operationId, changed.headers.get("Operation-Id")!));
  expect(events).toHaveLength(1);
  expect(events[0]?.data).toMatchObject({
    before: { revision: before.revision },
    after: { revision: saved.revision },
  });
  await expect(
    fixture.db
      .update(organizations)
      .set({ revision: 1 })
      .where(eq(organizations.id, before.id))
      .execute(),
  ).rejects.toThrow();
  expect((await read()).headers.get("ETag")).toBe(currentTag);
  for (const suffix of ["/disable", "/enable"]) {
    const response = await fixture.app.request(path() + suffix, {
      method: "POST",
      headers: fixture.headers("platformAdmin"),
    });
    expect(response.status).toBe(200);
    expect((await read()).headers.get("ETag")).not.toBe(currentTag);
    expect((await patch(`org-revision-${suffix}`, currentTag)).status).toBe(
      412,
    );
  }
  const active = await read();
  const activeTag = active.headers.get("ETag")!;
  const activeRow = await active.json();
  await fixture.db.execute(
    sql`update organizations set metadata = 'changed externally' where id = ${before.id}`,
  );
  const external = await read();
  expect(external.headers.get("ETag")).not.toBe(activeTag);
  expect((await external.json()).revision).toBe(activeRow.revision + 1);
  expect((await patch("org-revision-external", activeTag)).status).toBe(412);
  const externalTag = external.headers.get("ETag")!;
  await fixture.db.execute(
    sql`update organizations set metadata = metadata where id = ${before.id}`,
  );
  expect((await read()).headers.get("ETag")).toBe(externalTag);
  const competing = await Promise.all([
    patch("org-revision-racer-a", externalTag, "Racer A"),
    patch("org-revision-racer-b", externalTag, "Racer B"),
  ]);
  expect(competing.map((response) => response.status).sort()).toEqual([
    200, 412,
  ]);
});
