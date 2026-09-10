import { expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import type { Database } from "../db/client.ts";
import type { AppEnvironment } from "./context.ts";
import { recordRejectedSignIn } from "./signin-audit.ts";

function setup(response: Response, fail = false) {
  const rows: unknown[] = [];
  const app = new Hono<AppEnvironment>();
  app.all("*", async (context) => {
    context.set("requestId", "request");
    context.set("db", {
      insert: () => ({
        values: (row: unknown) => {
          if (fail) throw new Error("offline");
          rows.push(row);
          return { returning: async () => [row] };
        },
      }),
    } as unknown as Database);
    await recordRejectedSignIn(context, response);
    return response;
  });
  return { app, rows };
}
test("redirect failure records correlation without trusting claimed provider or forwarded IP", async () => {
  for (const status of [302, 303]) {
    const { app, rows } = setup(
      new Response(null, {
        status,
        headers: {
          location: "/error?error=directory_mismatch&error_description=x",
        },
      }),
    );
    await app.request("/auth/sso/callback?providerId=tenant", {
      headers: {
        "x-forwarded-for": "192.0.2.1, 192.0.2.2",
        "user-agent": "agent",
      },
    });
    expect(rows[0]).not.toHaveProperty("data");
    expect(rows).toEqual([
      expect.objectContaining({
        actorType: "system",
        actorId: "sso-callback",
        action: "auth.signin.rejected",
        schemaVersion: 2,
        targetId: null,
        reason: "directory_mismatch",

        requestId: "request",
        ip: null,
        userAgent: "agent",
        outcome: "failure",
      }),
    ]);
  }
});
test("missing optional metadata stays null", async () => {
  const { app, rows } = setup(
    Response.redirect("https://example.com/error?error=denied"),
  );
  await app.request("/auth/sso/callback?state=opaque");
  expect(rows).toEqual([
    expect.objectContaining({
      targetId: null,
      ip: null,
      userAgent: null,
    }),
  ]);
});
test("ignores other paths, non-redirects, missing locations and successful redirects", async () => {
  for (const [path, response] of [
    ["/auth/ok", Response.redirect("https://example.com/?error=x")],
    ["/auth/sso/callback", new Response()],
    ["/auth/sso/callback", new Response(null, { status: 302 })],
    ["/auth/sso/callback", Response.redirect("https://example.com/success")],
  ] as const) {
    const { app, rows } = setup(response);
    await app.request(path);
    expect(rows).toHaveLength(0);
  }
});
test("audit failure preserves the redirect and logs one line", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const { app } = setup(
      Response.redirect("https://example.com/?error=x"),
      true,
    );
    expect((await app.request("/auth/sso/callback")).status).toBe(302);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]).toEqual([
      'Sign-in audit failed for request "request"',
    ]);
  } finally {
    log.mockRestore();
  }
});

for (const reported of ["private-token-value", "x".repeat(8192), ""]) {
  test(`unknown callback error is not copied into permanent evidence (${reported.length})`, async () => {
    const location = new URL("https://example.com/error");
    location.searchParams.set("error", reported);
    location.searchParams.set("error_description", "private-upstream-token");
    const { app, rows } = setup(Response.redirect(location));
    await app.request("/auth/sso/callback", {
      headers: { "user-agent": "x".repeat(513) },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      reason: "sso_callback_failed",
      userAgent: null,
    });
    expect(rows[0]).not.toHaveProperty("data");
    expect(JSON.stringify(rows)).not.toContain("private-upstream-token");
    if (reported) expect(JSON.stringify(rows)).not.toContain(reported);
  });
}
