import { expectReceipt } from "../../__tests__/operation-receipt.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
let fixture: AdminFixture;
const identifier = "https://replay-resource.example/mcp";
const path = `/resources/${encodeURIComponent(identifier)}`;
beforeAll(async () => {
  fixture = await createAdminFixture({ databasePoolMax: 2 });
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
async function operation(response: Response) {
  expect(response.headers.get("Operation-Id")).toBeString();
  return (
    await request(
      `/operations/${response.headers.get("Operation-Id")}`,
      "GET",
      "read",
    )
  ).json();
}
test("resource creation and revision-aware edits replay before stale checks", async () => {
  const input = {
    identifier,
    name: "Resource",
    allowedScopes: ["write", "read", "read"],
  };
  const created = await request("/resources", "POST", "create", input);
  expect(created.status).toBe(201);
  const body = await created.json();
  const replay = await request("/resources", "POST", "create", {
    ...input,
    allowedScopes: ["read", "write"],
  });
  expect(replay.status).toBe(201);
  await expectReceipt(fixture.db, replay);
  expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
  const current = await request(path, "GET", "read");
  const tag = current.headers.get("ETag");
  expect(tag).toBeString();
  const patch = { name: "Changed" };
  const changed = await request(path, "PATCH", "patch", patch, tag!);
  expect(changed.status).toBe(200);
  const after = await changed.json();
  expect(after.revision).toBe(body.revision + 1);
  await expectReceipt(
    fixture.db,
    await request(path, "PATCH", "patch", patch, tag!),
  );
  const stale = await request(path, "PATCH", "stale", { name: "Lost" }, tag!);
  expect(stale.status).toBe(412);
  expect(await stale.json()).toMatchObject({ code: "revision_mismatch" });
  const noop = await request(
    path,
    "PATCH",
    "noop",
    patch,
    changed.headers.get("ETag")!,
  );
  expect(await noop.json()).toEqual(after);
  expect(await operation(noop)).toMatchObject({ outcome: "noop" });
});

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

test("resource lifecycle noops and historical erasure recovery preserve later state", async () => {
  const disabled = await request(path + "/disable", "POST", "disable");
  expect(disabled.status).toBe(200);
  expect(await operation(disabled)).toMatchObject({ outcome: "applied" });
  const disabledBody = await disabled.json();
  const noop = await request(path + "/disable", "POST", "disable-noop");
  expect(await noop.json()).toEqual(disabledBody);
  expect(await operation(noop)).toMatchObject({ outcome: "noop" });
  const enabled = await request(path + "/enable", "POST", "enable");
  expect(await operation(enabled)).toMatchObject({ outcome: "applied" });
  const enabledBody = await enabled.json();
  const enableNoop = await request(path + "/enable", "POST", "enable-noop");
  expect(await enableNoop.json()).toEqual(enabledBody);
  expect(await operation(enableNoop)).toMatchObject({ outcome: "noop" });
  await expectReceipt(
    fixture.db,
    await request(path + "/disable", "POST", "disable"),
  );
  expect(await (await request(path, "GET", "read")).json()).toMatchObject({
    disabled: false,
  });
  const erasePath = `${path}?${new URLSearchParams({ confirm: identifier })}`;
  const erased = await request(erasePath, "DELETE", "erase");
  expect(erased.status).toBe(204);
  const replay = await request(erasePath, "DELETE", "erase");
  expect(replay.status).toBe(204);
  await expectReceipt(fixture.db, replay);
  expect(replay.headers.get("Operation-Id")).toBe(
    erased.headers.get("Operation-Id"),
  );
  expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
  const createReplay = await request("/resources", "POST", "create", {
    identifier,
    name: "Resource",
    allowedScopes: ["read", "write"],
  });
  expect(createReplay.status).toBe(201);
  expect(createReplay.headers.get("Idempotency-Replayed")).toBe("true");
  expect((await request(path, "GET", "read")).status).toBe(404);
});

test("linked resource erasure fails without reserving its key; unlink permits a recoverable retry", async () => {
  const resource = "https://unlink-before-erase.example/mcp";
  const resourcePath = `/resources/${encodeURIComponent(resource)}`;
  expect(
    (
      await request("/resources", "POST", "linked-resource-create", {
        identifier: resource,
        name: "Linked",
        allowedScopes: ["read"],
      })
    ).status,
  ).toBe(201);
  const link = `/clients/${fixture.platform.client.clientId}/resources/${encodeURIComponent(resource)}`;
  expect((await request(link, "PUT", "linked-resource-link")).status).toBe(201);
  const erasePath = `${resourcePath}?confirm=${encodeURIComponent(resource)}`;
  const denied = await request(erasePath, "DELETE", "linked-resource-erase");
  expect(denied.status).toBe(409);
  expect(await denied.json()).toMatchObject({ code: "resource_has_clients" });
  expect(denied.headers.get("Operation-Id")).toBeNull();
  expect((await request(link, "DELETE", "linked-resource-unlink")).status).toBe(
    204,
  );
  const erased = await request(erasePath, "DELETE", "linked-resource-erase");
  expect(erased.status).toBe(204);
  expect(await operation(erased)).toMatchObject({ outcome: "applied" });
  const replay = await request(erasePath, "DELETE", "linked-resource-erase");
  expect(replay.status).toBe(204);
  expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
});

test("resource creation normalises omitted and explicit shared defaults for replay", async () => {
  const key = crypto.randomUUID();
  const input = {
    identifier: `https://${key}.example/resource`,
    name: "Resource",
    allowedScopes: ["read"],
  };
  const created = await request("/resources", "POST", key, input);
  expect(created.status).toBe(201);
  await created.json();
  const operationId = created.headers.get("Operation-Id");
  for (const body of [
    input,
    { ...input, classification: "platform_shared", organizationId: null },
  ]) {
    const response = await request("/resources", "POST", key, body);
    expect(response.status).toBe(201);
    expect(response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(response.headers.get("Operation-Id")).toBe(operationId);
    await expectReceipt(fixture.db, response);
  }
  expect(
    (
      await request("/resources", "POST", key, {
        ...input,
        classification: "tenant_owned",
        organizationId: fixture.tenant.organizationId,
      })
    ).status,
  ).toBe(409);
});
