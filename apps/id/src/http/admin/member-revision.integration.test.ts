import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { members, users } from "../../db/schema/index.ts";
let fixture: AdminFixture;
beforeAll(async () => {
  fixture = await createAdminFixture();
});
afterAll(async () => fixture?.close());
const path = () =>
  `/api/admin/v1/organizations/${fixture.tenant.organizationId}/members/${fixture.principals.tenantReader.memberId}`;
const read = () =>
  fixture.app.request(`${path()}/configuration`, {
    headers: fixture.headers("tenantUsersOnly"),
  });
function patch(
  key: string,
  tag?: string,
  validUntil: string | null = "2100-01-01T00:00:00.000Z",
) {
  const headers = fixture.headers("tenantUsersOnly");
  headers.set("Idempotency-Key", key);
  headers.set("content-type", "application/json");
  if (tag !== undefined) headers.set("If-Match", tag);
  return fixture.app.request(path(), {
    method: "PATCH",
    headers,
    body: JSON.stringify({ validUntil }),
  });
}
test("member configuration revisions prevent stale writes and preserve committed replay", async () => {
  const initial = await read();
  expect(initial.status).toBe(200);
  const tag = initial.headers.get("ETag")!;
  expect(tag).toBeString();
  const before = await initial.json();
  expect(before).not.toHaveProperty("groups");
  expect(before).not.toHaveProperty("email");
  expect(before).not.toHaveProperty("effective");
  const changed = await patch("first", tag);
  expect(changed.status).toBe(200);
  expect((await changed.json()).revision).toBe(before.revision + 1);
  expect((await patch("first", tag)).headers.get("Idempotency-Replayed")).toBe(
    "true",
  );
  const stale = await patch("second", tag, null);
  expect(stale.status).toBe(412);
  expect(await stale.json()).toMatchObject({ code: "revision_mismatch" });
  const current = await read();
  const currentTag = current.headers.get("ETag")!;
  const unchanged = await patch("noop", currentTag);
  expect(unchanged.status).toBe(200);
  expect((await read()).headers.get("ETag")).toBe(currentTag);
  expect((await patch("missing")).status).toBe(200);
  expect((await patch("weak", `W/${currentTag}`)).status).toBe(400);
  const original = await fixture.db
    .select()
    .from(members)
    .where(eq(members.id, before.id));
  await expect(
    fixture.db
      .update(members)
      .set({ revision: before.revision })
      .where(eq(members.id, before.id))
      .execute(),
  ).rejects.toThrow();
  expect(
    await fixture.db.select().from(members).where(eq(members.id, before.id)),
  ).toEqual(original);
  await fixture.db
    .update(users)
    .set({ name: "Changed display name" })
    .where(eq(users.id, before.userId));
  expect((await read()).headers.get("ETag")).toBe(currentTag);
  for (const [method, suffix] of [
    ["DELETE", ""],
    ["POST", "/reinstate"],
  ] as const) {
    const changed = await fixture.app.request(path() + suffix, {
      method,
      headers: fixture.headers("tenantUsersOnly"),
    });
    expect(changed.status).toBe(method === "DELETE" ? 204 : 200);
    expect((await read()).headers.get("ETag")).not.toBe(currentTag);
    expect((await patch(`after-${method}`, currentTag)).status).toBe(412);
  }
});
