import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { describeAdminRoutes } from "../../__tests__/admin-routes.ts";
import { auditEvents } from "../../db/schema/index.ts";
import { createId } from "../../lib/id.ts";
import { platformSummarySchema, routes } from "./platform.ts";

let fixture: AdminFixture;
beforeAll(async () => {
  fixture = await createAdminFixture();
});
afterAll(async () => {
  await fixture?.close();
});
describeAdminRoutes(routes, () => fixture);

test("getPlatformSummary: platform admin, reader and machine read fixture counts and negative-suite denials", async () => {
  await fixture.db.insert(auditEvents).values({
    id: createId(),
    action: "auth.signin.rejected",
    reason: "unknown_domain",
    actorType: "system",
    actorId: "test",
    targetType: "user",
    outcome: "failure",
  });
  const denied = await fixture.deniedEvents();
  expect(denied.length).toBeGreaterThan(0);
  const token = await fixture.mintMachineToken(["platform:read"]);
  for (const kind of [
    "platformAdmin",
    "platformReader",
    { bearer: token },
  ] as const) {
    const response = await fixture.app.request(
      "/api/admin/v1/platform/summary",
      { headers: fixture.headers(kind) },
    );
    expect(response.status).toBe(200);
    expect(platformSummarySchema.parse(await response.json())).toEqual({
      platform: {
        organizationId: fixture.platform.organizationId,
        groupId: fixture.platform.groupId,
      },
      organizations: { active: 3, disabled: 0 },
      users: { inert: 0, active: 8, disabled: 1 },
      clients: { total: 1, disabled: 0, unowned: 0 },
      resources: { total: 1, disabled: 0 },
      sessions: { active: 9 },
      signIns24h: {
        succeeded: 9,
        rejected: 1,
        rejectedByReason: { unknown_domain: 1 },
      },
      denied24h: denied.length,
    });
  }
});
