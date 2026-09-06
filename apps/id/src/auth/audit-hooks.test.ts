import { expect, test } from "bun:test";
import type { Executor } from "../db/client.ts";
import { sessionAuditHooks } from "./audit-hooks.ts";

for (const [hook, action] of [["delete", "auth.signout"]] as const) {
  test(`${hook} audits session attribution with null context and headers`, async () => {
    const rows: unknown[] = [];
    const db = {
      insert: () => ({
        values: (row: unknown) => {
          rows.push(row);
          return { returning: async () => [row] };
        },
      }),
    } as unknown as Executor;
    const hooks = sessionAuditHooks(db);
    await hooks[hook].after({ id: "session", userId: "user" }, null);
    await hooks[hook].after(
      {
        id: "session",
        userId: "user",
        activeOrganizationId: "org",
        ipAddress: "192.0.2.1",
        userAgent: "agent",
      },
      { headers: new Headers({ "x-request-id": "request" }) },
    );
    expect(rows).toEqual([
      {
        id: expect.any(String),
        actorType: "user",
        actorId: "user",
        organizationId: null,
        action,
        targetType: "session",
        targetId: "session",
        outcome: "success",
        requestId: null,
        ip: null,
        userAgent: null,
      },
      {
        id: expect.any(String),
        actorType: "user",
        actorId: "user",
        organizationId: "org",
        action,
        targetType: "session",
        targetId: "session",
        outcome: "success",
        requestId: "request",
        ip: "192.0.2.1",
        userAgent: "agent",
      },
    ]);
  });
}
