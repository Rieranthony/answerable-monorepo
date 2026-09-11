import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { describeAdminRoutes } from "../../__tests__/admin-routes.ts";
import { inPlatformWrite } from "../../__tests__/platform-context.ts";
import { createClient } from "../../services/clients.ts";
import { createResource } from "../../__tests__/resource-queries.ts";
import {
  auditEvents,
  organizationCapabilities,
  oauthClients,
} from "../../db/schema/index.ts";
import { createId } from "../../lib/id.ts";
import { routes } from "./capabilities.ts";
let fixture: AdminFixture;
beforeAll(async () => {
  fixture = await createAdminFixture();
});
afterAll(async () => {
  await fixture?.close();
});
describeAdminRoutes(routes, () => fixture);
const base = () =>
  `/api/admin/v1/organizations/${fixture.tenant.organizationId}/capabilities`;
async function setup() {
  const client = await inPlatformWrite(fixture.db, (context) =>
    createClient(context, {
      clientId: `cap-${createId()}`,
      name: "Capability proof",
      organizationId: fixture.tenant.organizationId,
      grantTypes: ["client_credentials"],
      redirectUris: [],
      tokenEndpointAuthMethod: "client_secret_basic",
      clientCredentialsScopes: ["tool:read", "tool:write"],
    }),
  );
  const resource = await createResource(fixture.db, {
    identifier: `https://${createId()}.example/api`,
    name: "Capability proof",
    allowedScopes: ["tool:read", "tool:write"],
  });
  return {
    clientId: client.clientId,
    resource: resource.identifier,
    grantKind: "client_credentials" as const,
    scopes: ["tool:write", "tool:read"],
  };
}
function request(
  method: string,
  path: string,
  body?: unknown,
  key = createId(),
  etag?: string,
) {
  const headers = fixture.headers("platformAdmin");
  headers.set("Idempotency-Key", key);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  if (etag !== undefined) headers.set("If-Match", etag);
  return fixture.app.request(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("capability commands recover outcomes, preserve revisions on noops, audit the actor and isolate tenant reads", async () => {
  const input = await setup();
  const key = createId();
  const first = await request("POST", base(), input, key);
  expect(first.status).toBe(201);
  const row = await first.json();
  const replay = await request(
    "POST",
    base(),
    {
      ...input,
      validFrom: null,
      validUntil: null,
      scopes: ["tool:read", "tool:write", "tool:read"],
    },
    key,
  );
  expect(replay.status).toBe(201);
  expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
  expect(await replay.json()).toEqual(row);
  expect(
    (await request("POST", base(), { ...input, scopes: ["tool:read"] }, key))
      .status,
  ).toBe(409);
  expect((await request("POST", base(), input)).status).toBe(409);
  const path = `${base()}/${row.id}`;
  const read = await request("GET", path);
  const etag = read.headers.get("ETag")!;
  expect(etag).toBeString();
  expect((await request("PATCH", path, { status: "active" })).status).toBe(200);
  expect(
    (
      await request(
        "PATCH",
        path,
        { scopes: ["tool:read"] },
        createId(),
        '"00000000-0000-7000-8000-000000000000:1"',
      )
    ).status,
  ).toBe(412);
  const noop = await request(
    "PATCH",
    path,
    { scopes: ["tool:read", "tool:write"], validFrom: null, validUntil: null },
    createId(),
    etag,
  );
  expect(noop.status).toBe(200);
  expect(await noop.json()).toEqual(row);
  const disableKey = createId();
  const disabled = await request(
    "PATCH",
    path,
    { status: "disabled" },
    disableKey,
    etag,
  );
  expect(disabled.status).toBe(200);
  const disabledRow = await disabled.json();
  expect(disabledRow.revision).toBe(row.revision + 1);
  expect(
    (await request("PATCH", path, { status: "active" }, createId(), etag))
      .status,
  ).toBe(412);
  const recovered = await request(
    "PATCH",
    path,
    { status: "disabled" },
    disableKey,
    etag,
  );
  expect(recovered.headers.get("Idempotency-Replayed")).toBe("true");
  expect(await recovered.json()).toEqual(disabledRow);
  const tenantRead = await fixture.app.request(path, {
    headers: fixture.headers("tenantReader"),
  });
  expect(tenantRead.status).toBe(200);
  expect(tenantRead.headers.get("Cache-Control")).toContain("no-store");
  expect(
    (
      await fixture.app.request(
        `/api/admin/v1/organizations/${fixture.outsider.organizationId}/capabilities/${row.id}`,
        { headers: fixture.headers("tenantReader") },
      )
    ).status,
  ).toBe(404);
  const listed = await fixture.app.request(`${base()}?limit=1`, {
    headers: fixture.headers("tenantReader"),
  });
  expect(listed.status).toBe(200);
  expect((await listed.json()).items[0].id).toBe(row.id);
  const events = await fixture.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.targetId, row.id));
  expect(events.map((event) => event.action)).toEqual([
    "capability.created",
    "capability.update_unchanged",
    "capability.update_unchanged",
    "capability.updated",
  ]);
  expect(
    events.every(
      (event) =>
        event.actorId === fixture.principals.platformAdmin.userId &&
        event.organizationId === fixture.tenant.organizationId &&
        event.operationId !== null,
    ),
  ).toBe(true);
  expect(events[3]!.data).toMatchObject({
    before: { status: "active", revision: 1 },
    after: { status: "disabled", revision: 2 },
  });
});

test("capability validation cannot change identity or approve foreign/unknown scopes and failed audit rolls back the receipt", async () => {
  const input = await setup();
  for (const patch of [
    { clientId: "missing" },
    { resource: "https://missing.example" },
  ])
    expect((await request("POST", base(), { ...input, ...patch })).status).toBe(
      404,
    );
  for (const patch of [
    { scopes: ["unknown"] },
    { grantKind: "authorization_code" },
    { extra: true },
    { clientId: fixture.platform.client.clientId },
  ])
    expect((await request("POST", base(), { ...input, ...patch })).status).toBe(
      400,
    );
  const invalidWindow = await request("POST", base(), {
    ...input,
    validFrom: "2030-01-02T00:00:00Z",
    validUntil: "2030-01-01T00:00:00Z",
  });
  expect(invalidWindow.status).toBe(400);
  const created = await request("POST", base(), input);
  const row = await created.json();
  const path = `${base()}/${row.id}`;
  const etag = (await request("GET", path)).headers.get("ETag")!;
  for (const patch of [
    {},
    { clientId: "changed" },
    { grantKind: "admin_session" },
    { scopes: ["unknown"] },
  ])
    expect((await request("PATCH", path, patch, createId(), etag)).status).toBe(
      400,
    );
  const key = createId();
  await fixture.db.execute(
    sql`create function fail_capability_audit() returns trigger language plpgsql as $$ begin if NEW.action = 'capability.updated' then raise exception 'audit unavailable'; end if; return NEW; end $$`,
  );
  await fixture.db.execute(
    sql`create trigger fail_capability_audit before insert on audit_events for each row execute function fail_capability_audit()`,
  );
  try {
    expect(
      (await request("PATCH", path, { status: "disabled" }, key, etag)).status,
    ).toBe(500);
    expect((await (await request("GET", path)).json()).status).toBe("active");
  } finally {
    await fixture.db.execute(
      sql`drop trigger fail_capability_audit on audit_events`,
    );
    await fixture.db.execute(sql`drop function fail_capability_audit()`);
  }
  const retried = await request(
    "PATCH",
    path,
    { status: "disabled" },
    key,
    etag,
  );
  expect(retried.status).toBe(200);
  expect(retried.headers.get("Idempotency-Replayed")).toBe("false");
  expect(
    await fixture.db
      .select()
      .from(organizationCapabilities)
      .where(
        and(
          eq(organizationCapabilities.id, row.id),
          eq(organizationCapabilities.status, "disabled"),
        ),
      ),
  ).toHaveLength(1);
});

test("removal replays after deletion, preserves evidence and blocks resource erasure until references are removed", async () => {
  const input = await setup();
  const created = await request("POST", base(), input);
  const row = await created.json();
  const resourcePath = `/api/admin/v1/resources/${encodeURIComponent(input.resource)}?confirm=${encodeURIComponent(input.resource)}`;
  const blocked = await request("DELETE", resourcePath);
  expect(blocked.status).toBe(409);
  expect(await blocked.json()).toMatchObject({
    code: "capability_references_exist",
  });
  const path = `${base()}/${row.id}`;
  const key = createId();
  const removed = await request("DELETE", path, undefined, key);
  expect(removed.status).toBe(204);
  const replay = await request("DELETE", path, undefined, key);
  expect(replay.status).toBe(204);
  expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
  expect((await request("GET", path)).status).toBe(404);
  expect((await request("DELETE", path)).status).toBe(404);
  const [event] = await fixture.db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.targetId, row.id),
        eq(auditEvents.action, "capability.removed"),
      ),
    );
  expect(event!.data).toMatchObject({
    before: { id: row.id, scopes: ["tool:read", "tool:write"] },
    after: { id: row.id, status: "disabled", deletedAt: expect.any(String) },
  });
  expect((await request("DELETE", resourcePath)).status).toBe(204);
});

test("platform writers can suspend and remove legacy user capabilities even after registration narrows", async () => {
  const input = await setup();
  const [row] = await fixture.db
    .insert(organizationCapabilities)
    .values({
      ...input,
      id: createId(),
      organizationId: fixture.tenant.organizationId,
      grantKind: "authorization_code",
    })
    .returning();
  const path = `${base()}/${row!.id}`;
  const etag = (await request("GET", path)).headers.get("ETag")!;
  expect(
    (await request("PATCH", path, { status: "disabled" }, createId(), etag))
      .status,
  ).toBe(200);
  expect((await request("DELETE", path)).status).toBe(204);
  expect((await request("GET", path)).status).toBe(404);
});

test("a machine cannot recover a capability command after its own approval is revoked", async () => {
  const input = await setup();
  const token = await fixture.mintMachineToken();
  const headers = fixture.headers({ bearer: token });
  headers.set("Content-Type", "application/json");
  const send = () =>
    fixture.app.request(base(), {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    });
  const created = await send();
  expect(created.status).toBe(201);
  const row = await created.json();
  const [own] = await fixture.db
    .select()
    .from(organizationCapabilities)
    .where(
      eq(organizationCapabilities.clientId, fixture.platform.client.clientId),
    );
  await fixture.db
    .update(organizationCapabilities)
    .set({ status: "disabled" })
    .where(eq(organizationCapabilities.id, own!.id));
  try {
    const denied = await send();
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: "insufficient_scope" });
    expect(
      await fixture.db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.targetId, row.id),
            eq(auditEvents.action, "capability.created"),
          ),
        ),
    ).toHaveLength(1);
  } finally {
    await fixture.db
      .update(organizationCapabilities)
      .set({ status: "active" })
      .where(eq(organizationCapabilities.id, own!.id));
  }
});

test("direct-session ceilings narrow assignments and can be removed/recreated without restoring old receipt effects", async () => {
  const [cap] = await fixture.db
    .select()
    .from(organizationCapabilities)
    .where(
      and(
        eq(
          organizationCapabilities.organizationId,
          fixture.tenant.organizationId,
        ),
        eq(organizationCapabilities.grantKind, "admin_session"),
      ),
    );
  const path = `${base()}/${cap!.id}`;
  const etag = (await request("GET", path)).headers.get("ETag")!;
  const narrowed = await request(
    "PATCH",
    path,
    { scopes: ["org:read"] },
    createId(),
    etag,
  );
  expect(narrowed.status).toBe(200);
  const me = await fixture.app.request("/api/admin/v1/me", {
    headers: fixture.headers("tenantAdmin"),
  });
  expect(
    (await me.json()).grants.find(
      (grant: { organizationId: string }) =>
        grant.organizationId === fixture.tenant.organizationId,
    ).scopes,
  ).toEqual(["org:read"]);
  const key = createId();
  expect((await request("DELETE", path, undefined, key)).status).toBe(204);
  const noAuthority = await fixture.app.request("/api/admin/v1/me", {
    headers: fixture.headers("tenantAdmin"),
  });
  expect((await noAuthority.json()).grants).toEqual([]);
  // A different tenant's ceiling and identity still work.
  expect(
    (
      await fixture.app.request(
        `/api/admin/v1/organizations/${fixture.outsider.organizationId}`,
        { headers: fixture.headers("outsider") },
      )
    ).status,
  ).toBe(200);
  const approved = await request("POST", base(), {
    resource: fixture.platform.adminResource,
    grantKind: "admin_session",
    scopes: ["org:read", "org:users", "org:write"],
  });
  expect(approved.status).toBe(201);
  const row = await approved.json();
  expect(row.id).not.toBe(cap!.id);
  expect(row.clientId).toBeNull();
  const replay = await request("DELETE", path, undefined, key);
  expect(replay.status).toBe(204);
  expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
  expect((await request("GET", `${base()}/${row.id}`)).status).toBe(200);
});

test("direct-session approval rejects foreign resources, platform scopes for tenants and non-admin scope vocabulary", async () => {
  for (const input of [
    { resource: "https://missing.example", scopes: ["org:read"] },
    { resource: fixture.platform.adminResource, scopes: ["platform:write"] },
    { resource: fixture.platform.adminResource, scopes: ["unknown"] },
  ]) {
    const response = await request("POST", base(), {
      ...input,
      grantKind: "admin_session",
    });
    expect(response.status).toBe(
      input.resource === "https://missing.example" ? 404 : 400,
    );
  }
  const input = await setup();
  const response = await request("POST", base(), {
    resource: input.resource,
    scopes: ["tool:read"],
    grantKind: "admin_session",
  });
  expect(response.status).toBe(400);
});

test("platform user approvals distinguish login, exact pair and renewal across tenants and replay safely", async () => {
  const machine = await setup();
  await fixture.db
    .update(oauthClients)
    .set({
      grantTypes: ["authorization_code", "refresh_token"],
      scopes: ["openid", "offline_access", "tool:read", "tool:write"],
    })
    .where(eq(oauthClients.clientId, machine.clientId));
  for (const organizationId of [
    fixture.tenant.organizationId,
    fixture.outsider.organizationId,
  ]) {
    const endpoint = `/api/admin/v1/organizations/${organizationId}/capabilities`;
    for (const target of [
      {
        resource: null,
        grantKind: "authorization_code",
        scopes: ["openid", "offline_access"],
      },
      {
        resource: machine.resource,
        grantKind: "authorization_code",
        scopes: ["tool:read"],
      },
      {
        resource: machine.resource,
        grantKind: "refresh_token",
        scopes: ["tool:read"],
      },
    ]) {
      const input = { clientId: machine.clientId, ...target };
      const key = createId();
      const created = await request("POST", endpoint, input, key);
      expect(created.status).toBe(201);
      const row = await created.json();
      const replay = await request("POST", endpoint, input, key);
      expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
      expect(await replay.json()).toEqual(row);
      const path = `${endpoint}/${row.id}`;
      const etag = (await request("GET", path)).headers.get("ETag")!;
      const narrowed = await request(
        "PATCH",
        path,
        { scopes: [target.scopes[0]] },
        createId(),
        etag,
      );
      expect(narrowed.status).toBe(200);
      const tenantHeaders = fixture.headers("tenantAdmin");
      tenantHeaders.set("Content-Type", "application/json");
      expect(
        (
          await fixture.app.request(endpoint, {
            method: "POST",
            headers: tenantHeaders,
            body: JSON.stringify(input),
          })
        ).status,
      ).toBe(403);
      expect((await request("DELETE", path)).status).toBe(204);
      const events = await fixture.db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.targetId, row.id));
      expect(events).toHaveLength(3);
      expect(
        events.every(
          (event) =>
            event.organizationId === organizationId &&
            event.operationId !== null,
        ),
      ).toBe(true);
    }
  }
  expect(
    (
      await request("POST", base(), {
        clientId: machine.clientId,
        resource: null,
        grantKind: "refresh_token",
        scopes: ["openid"],
      })
    ).status,
  ).toBe(201);
  for (const target of [
    { resource: null, grantKind: "authorization_code", scopes: ["tool:read"] },
    {
      resource: machine.resource,
      grantKind: "authorization_code",
      scopes: ["openid"],
    },
    {
      resource: machine.resource,
      grantKind: "refresh_token",
      scopes: ["unknown"],
    },
  ])
    expect(
      (await request("POST", base(), { clientId: machine.clientId, ...target }))
        .status,
    ).toBe(400);
});

test("user approvals reject unsupported registration and foreign private resources without borrowing machine scopes", async () => {
  const machine = await setup();
  const input = {
    ...machine,
    grantKind: "refresh_token",
    scopes: ["tool:read"],
  };
  for (const registration of [
    { grantTypes: null, scopes: ["tool:read"] },
    { grantTypes: ["authorization_code"], scopes: ["tool:read"] },
    { grantTypes: ["authorization_code", "refresh_token"], scopes: null },
  ]) {
    await fixture.db
      .update(oauthClients)
      .set(registration)
      .where(eq(oauthClients.clientId, machine.clientId));
    expect((await request("POST", base(), input)).status).toBe(400);
  }
  await fixture.db
    .update(oauthClients)
    .set({
      grantTypes: ["authorization_code", "refresh_token"],
      scopes: ["tool:read", "openid"],
    })
    .where(eq(oauthClients.clientId, machine.clientId));
  const privateResource = await createResource(fixture.db, {
    identifier: `https://${createId()}.example/private`,
    name: "Private",
    allowedScopes: ["tool:read"],
    classification: "tenant_owned",
    organizationId: fixture.outsider.organizationId,
  });
  expect(
    (
      await request("POST", base(), {
        ...input,
        resource: privateResource.identifier,
      })
    ).status,
  ).toBe(400);
  const key = createId();
  const login = {
    clientId: machine.clientId,
    grantKind: "authorization_code",
    scopes: ["openid"],
  };
  const first = await request("POST", base(), login, key);
  expect(first.status).toBe(201);
  const row = await first.json();
  expect(row.resource).toBeNull();
  const replay = await request(
    "POST",
    base(),
    { ...login, resource: null },
    key,
  );
  expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
  expect(await replay.json()).toEqual(row);
});

test("the bound platform ceiling can be removed even when it supplies the last writer", async () => {
  const { hasPlatformWriter } = await import("../../db/queries/grants.ts");
  const policy = { resource: fixture.platform.adminResource };
  expect(await hasPlatformWriter(fixture.db, policy)).toBe(true);
  const [ceiling] = await fixture.db
    .select()
    .from(organizationCapabilities)
    .where(
      and(
        eq(
          organizationCapabilities.organizationId,
          fixture.platform.organizationId,
        ),
        eq(organizationCapabilities.grantKind, "admin_session"),
      ),
    );
  const response = await request(
    "DELETE",
    `/api/admin/v1/organizations/${fixture.platform.organizationId}/capabilities/${ceiling!.id}`,
  );
  expect(response.status).toBe(204);
  expect(await hasPlatformWriter(fixture.db, policy)).toBe(false);
});
