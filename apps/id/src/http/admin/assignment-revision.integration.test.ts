import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { createGroup, removeGroupMember } from "../../__tests__/group-queries.ts";
let fixture: AdminFixture;
beforeAll(async () => {
  fixture = await createAdminFixture();
});
afterAll(async () => fixture?.close());

test("assignment creation and replacement preconditions protect recreated pairs and historical replay", async () => {
  const org = fixture.tenant.organizationId;
  const member = fixture.principals.tenantAdmin.memberId;
  const group = await createGroup(fixture.db, {
    organizationId: org,
    slug: "assignment-revision",
    name: "Assignment",
  });
  const path = `/api/admin/v1/organizations/${org}/groups/${group.id}/members/${member}`;
  const read = (
    kind: Parameters<AdminFixture["headers"]>[0] = "platformAdmin",
  ) => fixture.app.request(path, { headers: fixture.headers(kind) });
  const put = (key: string, condition: Record<string, string>, body = {}) => {
    const headers = fixture.headers("platformAdmin");
    headers.set("Idempotency-Key", key);
    headers.set("Content-Type", "application/json");
    for (const [name, value] of Object.entries(condition))
      headers.set(name, value);
    return fixture.app.request(path, {
      method: "PUT",
      headers,
      body: JSON.stringify(body),
    });
  };
  expect((await read()).status).toBe(404);
  expect((await put("missing", {})).status).toBe(428);
  expect((await put("invalid", { "If-None-Match": '"other"' })).status).toBe(
    400,
  );
  const created = await put("create", { "If-None-Match": "*" });
  expect(created.status).toBe(201);
  const original = await created.json();
  const originalTag = created.headers.get("ETag")!;
  expect(originalTag).toBe(`"${original.id}:1"`);
  const current = await read("tenantReader");
  expect(current.status).toBe(200);
  expect(await current.json()).toEqual(original);
  expect(current.headers.get("ETag")).toBe(originalTag);
  expect((await read("outsider")).status).toBe(404);
  expect((await put("exists", { "If-None-Match": "*" })).status).toBe(412);
  expect(
    (await put("both", { "If-None-Match": "*", "If-Match": originalTag }))
      .status,
  ).toBe(400);
  expect((await put("weak", { "If-Match": `W/${originalTag}` })).status).toBe(
    400,
  );
  const changed = await put(
    "change",
    { "If-Match": originalTag },
    { validUntil: "2100-01-01T00:00:00.000Z" },
  );
  expect(changed.status).toBe(200);
  const saved = await changed.json();
  const nextTag = changed.headers.get("ETag")!;
  expect(saved.id).toBe(original.id);
  expect(saved.revision).toBe(2);
  expect((await put("stale", { "If-Match": originalTag })).status).toBe(412);
  const replayCreate = await put("create", { "If-None-Match": "*" });
  expect(replayCreate.status).toBe(201);
  expect(replayCreate.headers.get("Idempotency-Replayed")).toBe("true");
  expect(await replayCreate.json()).toEqual(original);
  expect(replayCreate.headers.get("ETag")).toBe(originalTag);
  const noop = await put("noop", { "If-Match": nextTag });
  expect(noop.status).toBe(200);
  expect(await noop.json()).toEqual(saved);
  expect(noop.headers.get("ETag")).toBe(nextTag);
  expect(
    (
      await put(
        "change",
        { "If-Match": nextTag },
        { validUntil: "2100-01-01T00:00:00.000Z" },
      )
    ).status,
  ).toBe(409);
  const race = await Promise.all([
    put("race-a", { "If-Match": nextTag }, { validUntil: null }),
    put(
      "race-b",
      { "If-Match": nextTag },
      { validFrom: "2000-01-01T00:00:00.000Z" },
    ),
  ]);
  expect(race.map((r) => r.status).sort()).toEqual([200, 412]);
  await removeGroupMember(fixture.db, org, group.id, member);
  expect((await put("gone", { "If-Match": nextTag })).status).toBe(412);
  const replacements = await Promise.all([
    put("recreate-a", { "If-None-Match": "*" }),
    put("recreate-b", { "If-None-Match": "*" }),
  ]);
  expect(replacements.map((r) => r.status).sort()).toEqual([201, 412]);
  const replacement = await (await read()).json();
  expect(replacement.id).not.toBe(original.id);
  expect(replacement.revision).toBe(1);
  expect((await put("old-instance", { "If-Match": originalTag })).status).toBe(
    412,
  );
  const historical = await put(
    "change",
    { "If-Match": originalTag },
    { validUntil: "2100-01-01T00:00:00.000Z" },
  );
  expect(historical.headers.get("Idempotency-Replayed")).toBe("true");
  expect(await historical.json()).toEqual(saved);
  expect(historical.headers.get("ETag")).toBe(nextTag);
  expect(await (await read()).json()).toEqual(replacement);
});
