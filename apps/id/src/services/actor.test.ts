import { expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnvironment } from "../http/context.ts";
import type { Principal } from "../http/principal.ts";
import { actorFromContext } from "./actor.ts";

for (const principal of [
  { type: "root", grants: [] },
  {
    type: "user",
    userId: "user",
    email: "a@example.com",
    sessionId: "session",
    grants: [],
  },
  { type: "client", clientId: "client", organizationId: "org", grants: [] },
] satisfies Principal[]) {
  test(`actorFromContext: ${principal.type} with and without request metadata`, async () => {
    const app = new Hono<AppEnvironment>();
    app.get("/", (context) => {
      context.set("principal", principal);
      context.set("requestId", "request");
      return context.json(actorFromContext(context));
    });
    expect(await (await app.request("/")).json()).toEqual({
      actorType: principal.type === "root" ? "system" : principal.type,
      actorId: principal.type,
      requestId: "request",
    });
    expect(
      await (
        await app.request("/", {
          headers: {
            "x-forwarded-for": " 192.0.2.1 , 198.51.100.1",
            "user-agent": "test",
          },
        })
      ).json(),
    ).toMatchObject({
      ip: "192.0.2.1",
      userAgent: "test",
    });
  });
}
