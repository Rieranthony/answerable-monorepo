import { expectReceipt } from "../../__tests__/operation-receipt.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { auditEvents, adminOperations } from "../../db/schema/index.ts";
let fixture: AdminFixture;
beforeAll(async () => {
  fixture = await createAdminFixture();
});
afterAll(async () => fixture?.close());
function request(path: string, method: string, key: string, body?: unknown) {
  const headers = fixture.headers("platformAdmin");
  headers.set("Idempotency-Key", key);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return fixture.app.request(`/api/admin/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function status(response: Response) {
  const id = response.headers.get("Operation-Id");
  expect(id).toBeString();
  const result = await request(`/operations/${id}`, "GET", "read");
  expect(result.status).toBe(200);
  return result.json();
}

test("client lifecycle commands recover original results and record new desired-state noops", async () => {
  const created = await request("/clients", "POST", "create-lifecycle", {
    clientId: "lifecycle",
    name: "Lifecycle",
    organizationId: fixture.tenant.organizationId,
    tokenEndpointAuthMethod: "client_secret_basic",
    grantTypes: ["client_credentials"],
    clientCredentialsScopes: ["tool:read"],
  });
  expect(created.status).toBe(201);
  const disabled = await request(
    "/clients/lifecycle/disable",
    "POST",
    "disable-once",
  );
  expect(disabled.status).toBe(200);
  const body = await disabled.json();
  expect(await status(disabled)).toMatchObject({ outcome: "applied" });
  const replay = await request(
    "/clients/lifecycle/disable",
    "POST",
    "disable-once",
  );
  await expectReceipt(fixture.db, replay);
  expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
  const noop = await request(
    "/clients/lifecycle/disable",
    "POST",
    "disable-again",
  );
  expect(noop.status).toBe(200);
  expect(await noop.json()).toEqual(body);
  expect(await status(noop)).toMatchObject({ outcome: "noop" });
  const enabled = await request(
    "/clients/lifecycle/enable",
    "POST",
    "enable-once",
  );
  expect(await status(enabled)).toMatchObject({ outcome: "applied" });
  const enabledBody = await enabled.json();
  const enableNoop = await request(
    "/clients/lifecycle/enable",
    "POST",
    "enable-again",
  );
  expect(await status(enableNoop)).toMatchObject({ outcome: "noop" });
  expect(await enableNoop.json()).toEqual(enabledBody);
  const oldDisable = await request(
    "/clients/lifecycle/disable",
    "POST",
    "disable-once",
  );
  await expectReceipt(fixture.db, oldDisable);
  const current = await request("/clients/lifecycle", "GET", "read");
  expect(await current.json()).toMatchObject({
    disabled: false,
    revision: enabledBody.revision,
  });
  const events = await fixture.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.operationId, disabled.headers.get("Operation-Id")!));
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    organizationId: fixture.tenant.organizationId,
    data: { before: { disabled: false }, after: { disabled: true } },
  });
});

test("resource links, immutable owner verification and erasure replay without recreating erased state", async () => {
  const resource = "https://lifecycle.example/mcp";
  expect(
    (
      await request("/resources", "POST", "resource", {
        identifier: resource,
        name: "Lifecycle",
        allowedScopes: ["tool:read"],
      })
    ).status,
  ).toBe(201);
  const path = `/clients/lifecycle/resources/${encodeURIComponent(resource)}`;
  const linked = await request(path, "PUT", "link-once");
  expect(linked.status).toBe(201);
  expect(await status(linked)).toMatchObject({ outcome: "applied" });
  const replay = await request(path, "PUT", "link-once");
  expect(replay.status).toBe(201);
  await expectReceipt(fixture.db, replay);
  expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
  const duplicate = await request(path, "PUT", "link-new-key");
  expect(duplicate.status).toBe(200);
  expect(await duplicate.json()).toEqual({ created: false });
  expect(await status(duplicate)).toMatchObject({ outcome: "noop" });
  const unlinked = await request(path, "DELETE", "unlink-once");
  expect(unlinked.status).toBe(204);
  expect(await unlinked.text()).toBe("");
  expect(await status(unlinked)).toMatchObject({ outcome: "applied" });
  const absent = await request(path, "DELETE", "unlink-new-key");
  expect(absent.status).toBe(204);
  expect(await status(absent)).toMatchObject({ outcome: "noop" });
  expect((await request(path, "PUT", "link-once")).status).toBe(201);
  expect(
    await (await request("/clients/lifecycle", "GET", "read")).json(),
  ).toMatchObject({ resources: [] });
  const ownerInput = { organizationId: fixture.tenant.organizationId };
  const owner = await request(
    "/clients/lifecycle/owner",
    "PUT",
    "owner-once",
    ownerInput,
  );
  expect(owner.status).toBe(200);
  expect(await status(owner)).toMatchObject({ outcome: "noop" });
  const ownerBody = await owner.json();
  const erased = await request(
    "/clients/lifecycle?confirm=lifecycle",
    "DELETE",
    "erase-once",
  );
  expect(erased.status).toBe(204);
  expect(await erased.text()).toBe("");
  const erasedStatus = await status(erased);
  const eraseReplay = await request(
    "/clients/lifecycle?confirm=lifecycle",
    "DELETE",
    "erase-once",
  );
  expect(eraseReplay.status).toBe(204);
  expect(eraseReplay.headers.get("Idempotency-Replayed")).toBe("true");
  expect(await status(eraseReplay)).toEqual(erasedStatus);
  expect((await request(path, "DELETE", "unlink-once")).status).toBe(204);
  await expectReceipt(
    fixture.db,
    await request("/clients/lifecycle/owner", "PUT", "owner-once", ownerInput),
  );
  const changedInput = await request(
    "/clients/lifecycle?confirm=different",
    "DELETE",
    "erase-once",
  );
  expect(changedInput.status).toBe(409);
  expect(await changedInput.json()).toMatchObject({
    code: "idempotency_key_reused",
  });
  expect((await request("/clients/lifecycle", "GET", "read")).status).toBe(404);
  const events = await fixture.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.operationId, erasedStatus.id));
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    action: "client.erased",
    organizationId: fixture.tenant.organizationId,
    schemaVersion: 3,
    data: {
      before: { id: ownerBody.id },
      after: {
        id: ownerBody.id,
        deletedAt: expect.any(String),
        disabled: true,
        hasClientSecret: false,
      },
    },
  });
});

test("failed lifecycle audit rolls back state and reservation; retry then commits", async () => {
  expect(
    (
      await request("/clients", "POST", "fault-create", {
        clientId: "fault-lifecycle",
        name: "Fault",
        tokenEndpointAuthMethod: "none",
        grantTypes: ["authorization_code"],
        redirectUris: ["https://fault.example/callback"],
      })
    ).status,
  ).toBe(201);
  const before = await (
    await request("/clients/fault-lifecycle", "GET", "read")
  ).json();
  const operations = await fixture.db.select().from(adminOperations);
  await fixture.db.execute(
    sql`alter table audit_events add constraint lifecycle_audit_fault check (action <> 'client.disabled') not valid`,
  );
  try {
    expect(
      (await request("/clients/fault-lifecycle/disable", "POST", "retry-fault"))
        .status,
    ).toBeGreaterThanOrEqual(400);
  } finally {
    await fixture.db.execute(
      sql`alter table audit_events drop constraint lifecycle_audit_fault`,
    );
  }
  expect(
    await (await request("/clients/fault-lifecycle", "GET", "read")).json(),
  ).toEqual(before);
  expect(await fixture.db.select().from(adminOperations)).toEqual(operations);
  const retried = await request(
    "/clients/fault-lifecycle/disable",
    "POST",
    "retry-fault",
  );
  expect(retried.status).toBe(200);
  expect(await status(retried)).toMatchObject({ outcome: "applied" });
});
