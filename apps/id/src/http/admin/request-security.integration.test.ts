import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { auditEvents, organizations } from "../../db/schema/index.ts";
let fixture: AdminFixture;
beforeAll(async () => {
  fixture = await createAdminFixture();
});
afterAll(async () => fixture?.close());

for (const method of ["POST", "DELETE"] as const) {
  test(`hostile cookie Origin cannot ${method} an organisation and the denial is audited`, async () => {
    const id = fixture.tenant.organizationId;
    const requestId = crypto.randomUUID();
    const before = await fixture.db.select().from(organizations);
    const headers = fixture.headers("platformAdmin");
    headers.set("Origin", "https://hostile.example");
    headers.set("x-request-id", requestId);
    const response = await fixture.app.request(
      `/api/admin/v1/organizations/${id}${method === "POST" ? "/disable" : `?confirm=${id}`}`,
      { method, headers },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "untrusted_origin" });
    expect(await fixture.db.select().from(organizations)).toEqual(before);
    const events = await fixture.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.requestId, requestId));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: "denied" });
  });
}

for (const entity of [
  "users",
  "resources",
  "organizations",
  "groups",
] as const) {
  test(`${entity} erase requires query confirmation and checks existence before mismatch`, async () => {
    const id =
      entity === "resources"
        ? "https://missing-confirm.example/mcp"
        : crypto.randomUUID();
    const different =
      entity === "resources"
        ? "https://different.example/mcp"
        : crypto.randomUUID();
    const path = `/api/admin/v1/${entity === "groups" ? `organizations/${fixture.tenant.organizationId}/groups` : entity}/${encodeURIComponent(id)}`;
    for (const [query, status, code] of [
      ["", 400, "validation_failed"],
      ["?confirm=invalid", 400, "validation_failed"],
      ["?" + new URLSearchParams({ confirm: id }), 404, "not_found"],
      ["?" + new URLSearchParams({ confirm: different }), 404, "not_found"],
    ] as const) {
      const response = await fixture.app.request(path + query, {
        method: "DELETE",
        headers: fixture.headers("platformAdmin"),
      });
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ code });
    }
    const headers = fixture.headers("platformAdmin");
    headers.set("content-type", "application/json");
    const response = await fixture.app.request(path, {
      method: "DELETE",
      headers,
      body: JSON.stringify({ confirm: id }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "validation_failed" });
  });
}
