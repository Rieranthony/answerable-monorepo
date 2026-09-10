import { eq } from "drizzle-orm";
import { auditEvents } from "../../db/schema/index.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
let fixture: AdminFixture;
beforeAll(async () => {
  fixture = await createAdminFixture({ databasePoolMax: 2 });
  const headers = fixture.headers("platformAdmin");
  headers.set("Content-Type", "application/json");
  const response = await fixture.app.request("/api/admin/v1/clients", {
    method: "POST",
    headers,
    body: JSON.stringify({
      clientId: "revision-client",
      name: "Before",
      organizationId: fixture.tenant.organizationId,
      tokenEndpointAuthMethod: "client_secret_basic",
      grantTypes: ["client_credentials"],
      clientCredentialsScopes: ["tool:read"],
    }),
  });
  expect(response.status).toBe(201);
});
afterAll(async () => fixture?.close());
function read() {
  return fixture.app.request("/api/admin/v1/clients/revision-client", {
    headers: fixture.headers("platformAdmin"),
  });
}
function patch(key: string, tag: string, name: string) {
  const headers = fixture.headers("platformAdmin");
  headers.set("Content-Type", "application/json");
  headers.set("Idempotency-Key", key);
  headers.set("If-Match", tag);
  return fixture.app.request("/api/admin/v1/clients/revision-client", {
    method: "PATCH",
    headers,
    body: JSON.stringify({ name }),
  });
}

test("configuration patches reject stale revisions but replay an already committed patch first", async () => {
  const initial = await read();
  const tag = initial.headers.get("ETag");
  expect(tag).toBeString();
  const before = await initial.json();
  const changed = await patch("change-once", tag!, "After");
  expect(changed.status).toBe(200);
  const after = await changed.json();
  expect(after.revision).toBe(before.revision + 1);
  const replay = await patch("change-once", tag!, "After");
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(after);
  expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
  const stale = await patch("stale-change", tag!, "Overwrite");
  expect(stale.status).toBe(412);
  expect(await stale.json()).toMatchObject({ code: "revision_mismatch" });
  const noop = await patch(
    "noop-change",
    changed.headers.get("ETag")!,
    "After",
  );
  expect(noop.status).toBe(200);
  expect(await noop.json()).toEqual(after);
  const status = await fixture.app.request(
    `/api/admin/v1/operations/${noop.headers.get("Operation-Id")}`,
    { headers: fixture.headers("platformAdmin") },
  );
  const operation = await status.json();
  expect(operation).toMatchObject({ outcome: "noop" });
  expect(
    new Date(operation.replayExpiresAt).getTime() -
      new Date(operation.committedAt).getTime(),
  ).toBeCloseTo(7 * 24 * 60 * 60 * 1000, -3);
  const events = await fixture.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.operationId, operation.id));
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    action: "client.update_unchanged",
    organizationId: fixture.tenant.organizationId,
    data: {
      before: { revision: after.revision },
      after: { revision: after.revision },
    },
  });
});

test("missing, weak, wildcard, malformed and unrelated tags do not update a client", async () => {
  const initial = await read();
  const tag = initial.headers.get("ETag")!;
  const before = await initial.json();
  for (const [value, status, code] of [
    [undefined, 428, "precondition_required"],
    [`W/${tag}`, 400, "invalid_revision"],
    ["*", 400, "invalid_revision"],
    [`${tag}, ${tag}`, 400, "invalid_revision"],
    ['"wrong:1"', 400, "invalid_revision"],
    [`"${before.id}:999999999999999999999"`, 400, "invalid_revision"],
    [`"${crypto.randomUUID()}:${before.revision}"`, 412, "revision_mismatch"],
  ] as const) {
    const headers = fixture.headers("platformAdmin");
    headers.set("Content-Type", "application/json");
    if (value !== undefined) headers.set("If-Match", value);
    const response = await fixture.app.request(
      "/api/admin/v1/clients/revision-client",
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ name: "Rejected" }),
      },
    );
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code });
  }
  expect(await (await read()).json()).toEqual(before);
});

test("concurrent different operations cannot overwrite the same revision", async () => {
  const initial = await read();
  const tag = initial.headers.get("ETag")!;
  const before = await initial.json();
  const responses = await Promise.all([
    patch("race-a", tag, "Race A"),
    patch("race-b", tag, "Race B"),
  ]);
  expect(responses.map((response) => response.status).sort()).toEqual([
    200, 412,
  ]);
  const after = await (await read()).json();
  expect(after.revision).toBe(before.revision + 1);
  expect(["Race A", "Race B"]).toContain(after.name);
});

test("linked resource changes invalidate the client ETag, but duplicate links do not", async () => {
  const resource = "https://client-revision.example/mcp";
  const headers = fixture.headers("platformAdmin");
  headers.set("Content-Type", "application/json");
  expect(
    (
      await fixture.app.request("/api/admin/v1/resources", {
        method: "POST",
        headers,
        body: JSON.stringify({
          identifier: resource,
          name: "Revision",
          allowedScopes: ["tool:read"],
        }),
      })
    ).status,
  ).toBe(201);
  const initial = await read();
  const tag = initial.headers.get("ETag")!;
  const link = `/api/admin/v1/clients/revision-client/resources/${encodeURIComponent(resource)}`;
  expect(
    (await fixture.app.request(link, { method: "PUT", headers })).status,
  ).toBe(201);
  const linked = await read();
  const linkedTag = linked.headers.get("ETag");
  expect(linkedTag).not.toBe(tag);
  expect((await linked.json()).resources).toContain(resource);
  expect((await patch("before-link", tag, "Stale link view")).status).toBe(412);
  headers.set("Idempotency-Key", "duplicate-link-new-command");
  expect(
    (await fixture.app.request(link, { method: "PUT", headers })).status,
  ).toBe(200);
  expect((await read()).headers.get("ETag")).toBe(linkedTag);
  expect(
    (await fixture.app.request(link, { method: "DELETE", headers })).status,
  ).toBe(204);
  const unlinked = await read();
  expect(unlinked.headers.get("ETag")).not.toBe(linkedTag);
  expect((await unlinked.json()).resources).not.toContain(resource);
});
