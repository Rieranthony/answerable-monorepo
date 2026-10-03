import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
let fixture: AdminFixture;
const identifier = "https://replay-resource.example/mcp";
const path = `/resources/${encodeURIComponent(identifier)}`;
beforeAll(async () => {
  fixture = await createAdminFixture(
    { databasePoolMax: 2 },
    { restrictedRole: true },
  );
  const created = await request("/resources", "POST", "create", {
    identifier,
    name: "Resource",
    allowedScopes: ["read", "write"],
  });
  expect(created.status).toBe(201);
});
afterAll(async () => fixture?.close());
function request(
  target: string,
  method: string,
  key: string,
  body?: unknown,
  tag?: string,
) {
  const headers = fixture.headers("platformAdmin");
  headers.set("Idempotency-Key", key);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  if (tag !== undefined) headers.set("If-Match", tag);
  return fixture.app.request(`/api/admin/v1${target}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("resource preconditions and concurrent edits reject lost updates", async () => {
  expect(
    (await request(path, "PATCH", "missing-tag", { name: "Invalid" })).status,
  ).toBe(200);
  expect(
    (
      await request(
        path,
        "PATCH",
        "weak-tag",
        { name: "Invalid" },
        'W/"invalid"',
      )
    ).status,
  ).toBe(400);
  const current = await request(path, "GET", "read");
  const before = await current.json();
  const tag = current.headers.get("ETag")!;
  const attempts = await Promise.all([
    request(path, "PATCH", "race-a", { name: "Race A" }, tag),
    request(path, "PATCH", "race-b", { name: "Race B" }, tag),
  ]);
  expect(attempts.map((response) => response.status).sort()).toEqual([
    200, 412,
  ]);
  expect(await (await request(path, "GET", "read")).json()).toMatchObject({
    revision: before.revision + 1,
  });
});

test("resource tags cover linked clients and client deletion cascades", async () => {
  const client = await request("/clients", "POST", "resource-client", {
    clientId: "resource-revision-client",
    name: "Client",
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code"],
    redirectUris: ["https://client.example/callback"],
  });
  expect(client.status).toBe(201);
  const before = await request(path, "GET", "read");
  const tag = before.headers.get("ETag");
  const link = `/clients/resource-revision-client/resources/${encodeURIComponent(identifier)}`;
  expect((await request(link, "PUT", "link")).status).toBe(201);
  const linked = await request(path, "GET", "read");
  const linkedTag = linked.headers.get("ETag");
  expect(linkedTag).not.toBe(tag);
  expect((await linked.json()).clients).toContain("resource-revision-client");
  expect((await request(link, "PUT", "link-noop")).status).toBe(200);
  expect((await request(path, "GET", "read")).headers.get("ETag")).toBe(
    linkedTag,
  );
  expect(
    (
      await request(
        "/clients/resource-revision-client?confirm=resource-revision-client",
        "DELETE",
        "erase-client",
      )
    ).status,
  ).toBe(204);
  const unlinked = await request(path, "GET", "read");
  expect(unlinked.headers.get("ETag")).not.toBe(linkedTag);
  expect((await unlinked.json()).clients).toEqual([]);
});
