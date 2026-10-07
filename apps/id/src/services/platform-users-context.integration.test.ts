import { afterAll, beforeAll, expect, test } from "bun:test";
import { createAdminFixture, type AdminFixture } from "../__tests__/admin.ts";
import { createId } from "../lib/id.ts";
import { authorizePlatformMutation } from "./platform-context.ts";
let fixture: AdminFixture;
beforeAll(async () => {
  fixture = await createAdminFixture();
});
afterAll(async () => fixture?.close());
const actor = {
  actorType: "system" as const,
  actorId: "context-test",
  requestId: "context-test",
};

for (const access of ["users", "write"] as const) {
  test(`platform ${access}: actor identity comes from authority, never metadata`, async () => {
    const metadata = {
      ...actor,
      actorType: "user" as const,
      actorId: createId(),
      operationId: createId(),
      ip: "192.0.2.1",
      userAgent: "test",
    };
    await fixture.db.transaction(async (tx) => {
      const authority = await authorizePlatformMutation(
        tx,
        {
          principal: { type: "root", grants: [] },
          environment: fixture.environment,
        },
        access,
      );
      await authority.run(async (context) => {
        expect(context.actor).toEqual({
          ...metadata,
          actorType: "system",
          actorId: "root",
        });
        metadata.requestId = "changed";
        expect(context.actor.requestId).toBe("context-test");
      }, metadata);
    });
  });
}
