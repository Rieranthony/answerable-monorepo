import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { describeAdminRoutes } from "../../__tests__/admin-routes.ts";
import { auditEvents, entitlements } from "../../db/schema/index.ts";
import { createId } from "../../lib/id.ts";
import { routes, resourceSchema } from "./resources.ts";
let fixture: AdminFixture;
beforeAll(async () => {
  fixture = await createAdminFixture();
});
afterAll(async () => {
  await fixture?.close();
});
describeAdminRoutes(routes, () => fixture, {
  params: () => ({
    resource: encodeURIComponent(fixture.platform.adminResource),
  }),
});
function request(
  path = "",
  method = "GET",
  body?: unknown,
  kind: Parameters<AdminFixture["headers"]>[0] = "platformAdmin",
) {
  const headers = fixture.headers(kind);
  headers.set("x-request-id", "resources-http-test");
  if (body !== undefined) headers.set("content-type", "application/json");
  return fixture.app.request(`/api/admin/v1/resources${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
for (const machine of [false, true])
  test(`${machine ? "machine" : "platformAdmin"} performs the complete resource lifecycle`, async () => {
    const kind = machine
      ? { bearer: await fixture.mintMachineToken() }
      : "platformAdmin";
    const identifier = `https://${machine ? "machine" : "human"}.example.com/mcp`;
    const path = "/" + encodeURIComponent(identifier);
    const input = {
      identifier,
      name: "Example MCP",
      allowedScopes: ["tutor:read"],
      accessTokenTtl: 120,
      refreshTokenTtl: 600,
      signingAlgorithm: "EdDSA",
    };
    const response = await request("", "POST", input, kind);
    expect(response.status).toBe(201);
    const row = resourceSchema.parse(await response.json());
    expect(row).toMatchObject(input);
    expect((await request(path, "GET", undefined, kind)).status).toBe(200);
    const page = await (
      await request(
        "?q=" + encodeURIComponent(identifier) + "&disabled=false",
        "GET",
        undefined,
        kind,
      )
    ).json();
    expect(page.items.map((r: { id: string }) => r.id)).toEqual([row.id]);
    expect(
      (await request(path, "PATCH", { name: "Renamed" }, kind)).status,
    ).toBe(200);
    expect(
      (await request(path + "/disable", "POST", undefined, kind)).status,
    ).toBe(200);
    expect(
      (
        await request(
          "?disabled=true&q=" + encodeURIComponent(identifier),
          "GET",
          undefined,
          kind,
        )
      ).status,
    ).toBe(200);
    expect(
      (await request(path + "/enable", "POST", undefined, kind)).status,
    ).toBe(200);
    const entitlementId = createId();
    await fixture.db.insert(entitlements).values({
      id: entitlementId,
      organizationId: fixture.tenant.organizationId,
      resource: identifier,
      scopes: ["tutor:read"],
    });
    const blocked = await request(
      path,
      "DELETE",
      { confirm: identifier },
      kind,
    );
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({
      code: "resource_has_entitlements",
    });
    await fixture.db
      .delete(entitlements)
      .where(eq(entitlements.id, entitlementId));
    expect(
      (await request(path, "DELETE", { confirm: identifier }, kind)).status,
    ).toBe(204);
    expect((await request(path, "GET", undefined, kind)).status).toBe(404);
    const events = await fixture.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.targetId, identifier))
      .orderBy(auditEvents.id);
    expect(events.map((e) => e.action)).toEqual([
      "resource.created",
      "resource.updated",
      "resource.disabled",
      "resource.enabled",
      "resource.erased",
    ]);
    for (const event of events)
      expect(event).toMatchObject({
        targetType: "resource",
        actorType: machine ? "client" : "user",
        actorId: machine
          ? fixture.platform.client.clientId
          : fixture.principals.platformAdmin.userId,
        requestId: "resources-http-test",
      });
  });
test("resource conflicts, protection, confirmation and validation use problem responses", async () => {
  const identifier = "https://conflicts.example/mcp";
  const path = "/" + encodeURIComponent(identifier);
  const input = { identifier, name: "Conflicts", allowedScopes: ["read"] };
  expect((await request("", "POST", input)).status).toBe(201);
  const duplicate = await request("", "POST", input);
  expect(duplicate.status).toBe(409);
  expect(await duplicate.json()).toMatchObject({ code: "conflict" });
  for (const body of [
    {},
    { name: "" },
    { accessTokenTtl: 59 },
    { accessTokenTtl: 3601 },
    { accessTokenTtl: 60.5 },
    { refreshTokenTtl: 59 },
    { allowedScopes: [] },
    { allowedScopes: [""] },
  ]) {
    const response = await request(path, "PATCH", body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "validation_failed",
      errors: expect.any(Array),
    });
  }
  expect((await request("/not-a-url")).status).toBe(400);
  const mismatch = await request(path, "DELETE", {
    confirm: "https://wrong.example",
  });
  expect(mismatch.status).toBe(400);
  expect(await mismatch.json()).toMatchObject({
    code: "confirmation_mismatch",
  });
  expect((await request(path + "/enable", "POST")).status).toBe(409);
  expect((await request(path + "/disable", "POST")).status).toBe(200);
  expect((await request(path + "/disable", "POST")).status).toBe(409);
  for (const [suffix, method, body] of [
    ["/disable", "POST", undefined],
    ["", "DELETE", { confirm: fixture.platform.adminResource }],
  ] as const) {
    const response = await request(
      "/" + encodeURIComponent(fixture.platform.adminResource) + suffix,
      method,
      body,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "resource_protected" });
  }
});
test("resource cursor pages have no gaps", async () => {
  const identifiers = ["one", "two", "three"].map(
    (n) => `https://${n}.pagination.example`,
  );
  const ids: string[] = [];
  for (const identifier of identifiers)
    ids.push(
      (
        await (
          await request("", "POST", {
            identifier,
            name: "Pagination",
            allowedScopes: ["read"],
          })
        ).json()
      ).id,
    );
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const response = await request(
      "?q=pagination&limit=1" + (cursor ? "&cursor=" + cursor : ""),
    );
    expect(response.status).toBe(200);
    const page = await response.json();
    seen.push(...page.items.map((r: { id: string }) => r.id));
    cursor = page.nextCursor;
  } while (cursor);
  expect(seen).toEqual(ids.reverse());
});
