import { expectReceipt } from "../../__tests__/operation-receipt.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { createOrganization } from "../../__tests__/organization-queries.ts";
import { ssoProviders } from "../../db/schema/index.ts";
let fixture: AdminFixture;
beforeAll(async () => {
  fixture = await createAdminFixture();
});
afterAll(async () => fixture?.close());
const input = {
  issuer: "https://sso.example.com",
  domain: "sso.example.com",
  oidc: { clientId: "sso", clientSecret: "original-secret" },
};
function put(
  org: string,
  key: string,
  headers: Record<string, string>,
  body: unknown = input,
) {
  const auth = fixture.headers("platformAdmin");
  auth.set("Idempotency-Key", key);
  auth.set("Content-Type", "application/json");
  for (const [name, value] of Object.entries(headers)) auth.set(name, value);
  return fixture.app.request(
    `/api/admin/v1/organizations/${org}/sso-provider`,
    { method: "PUT", headers: auth, body: JSON.stringify(body) },
  );
}
const read = (org: string) =>
  fixture.app.request(`/api/admin/v1/organizations/${org}/sso-provider`, {
    headers: fixture.headers("platformAdmin"),
  });
test("SSO creation and replacement accept optional preconditions and preserve historical replay", async () => {
  const org = await createOrganization(fixture.db, {
    slug: "sso-revisions",
    name: "SSO revisions",
  });
  expect((await put(org.id, "bad", { "If-None-Match": "bad" })).status).toBe(
    400,
  );
  expect(
    (await put(org.id, "both", { "If-Match": "*", "If-None-Match": "*" }))
      .status,
  ).toBe(400);
  const created = await put(org.id, "create", { "If-None-Match": "*" });
  expect(created.status).toBe(201);
  expect((await put(org.id, "missing", {})).status).toBe(200);
  const first = await created.json();
  const tag = created.headers.get("ETag")!;
  expect(tag).toBeString();
  expect((await read(org.id)).headers.get("ETag")).toBe(tag);
  expect(
    (await put(org.id, "create", { "If-None-Match": "*" })).headers.get(
      "Idempotency-Replayed",
    ),
  ).toBe("true");
  expect(
    (await put(org.id, "other-create", { "If-None-Match": "*" })).status,
  ).toBe(412);
  const changedInput = {
    ...input,
    oidc: { ...input.oidc, clientSecret: "replacement-secret" },
  };
  const changed = await put(
    org.id,
    "replace",
    { "If-Match": tag },
    changedInput,
  );
  expect(changed.status).toBe(200);
  const after = await changed.json();
  const currentTag = changed.headers.get("ETag")!;
  expect(after.revision).toBe(first.revision + 1);
  expect(JSON.stringify(after)).not.toContain("replacement-secret");
  expect((await put(org.id, "stale", { "If-Match": tag })).status).toBe(412);
  expect(
    (await put(org.id, "weak", { "If-Match": `W/${currentTag}` })).status,
  ).toBe(400);
  const replay = await put(
    org.id,
    "replace",
    { "If-Match": tag },
    changedInput,
  );
  expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
  await expectReceipt(fixture.db, replay);
  const noop = await put(
    org.id,
    "noop",
    { "If-Match": currentTag },
    changedInput,
  );
  expect(noop.status).toBe(200);
  expect(await noop.json()).toEqual(after);
  expect(
    (await put(org.id, "replace", { "If-Match": currentTag }, changedInput))
      .status,
  ).toBe(409);
  await expect(
    fixture.db
      .update(ssoProviders)
      .set({ revision: 1 })
      .where(eq(ssoProviders.id, first.id))
      .execute(),
  ).rejects.toThrow();
  const removed = await fixture.app.request(
    `/api/admin/v1/organizations/${org.id}/sso-provider`,
    { method: "DELETE", headers: fixture.headers("platformAdmin") },
  );
  expect(removed.status).toBe(204);
  expect((await put(org.id, "gone", { "If-Match": currentTag })).status).toBe(
    412,
  );
  const recreated = await put(org.id, "recreate", { "If-None-Match": "*" });
  expect(recreated.status).toBe(201);
  const next = await recreated.json();
  expect(next.id).not.toBe(first.id);
  expect(
    (await put(org.id, "wrong-instance", { "If-Match": tag })).status,
  ).toBe(412);
  const nextTag = recreated.headers.get("ETag")!;
  const competing = await Promise.all([
    put(org.id, "race-a", { "If-Match": nextTag }, changedInput),
    put(
      org.id,
      "race-b",
      { "If-Match": nextTag },
      { ...input, domain: "changed.example.com" },
    ),
  ]);
  expect(competing.map((r) => r.status).sort()).toEqual([200, 412]);
  const beforeRaw = await read(org.id);
  const rawTag = beforeRaw.headers.get("ETag")!;
  await fixture.db.execute(
    sql`update sso_providers set oidc_config = oidc_config || ' ' where id = ${next.id}`,
  );
  expect((await read(org.id)).headers.get("ETag")).not.toBe(rawTag);
});
