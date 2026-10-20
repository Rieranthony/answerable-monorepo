import { expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnvironment } from "./context.ts";
import { logRejectedSignIn } from "./signin-rejection.ts";

// A refused callback has no verified identity, provider or tenant: it is an
// operational line, not an audit row.
async function lines(
  path: string,
  response: Response,
  clientIp: string | null = null,
) {
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const app = new Hono<AppEnvironment>();
    app.all("*", (context) => {
      context.set("requestId", "request");
      context.set("clientIp", clientIp);
      logRejectedSignIn(context, response);
      return response;
    });
    const answer = await app.request(path, {
      headers: { "x-forwarded-for": "192.0.2.1", "user-agent": "agent" },
    });
    expect(answer.status).toBe(response.status);
    return log.mock.calls.map(([area, json]) => [area, JSON.parse(json)]);
  } finally {
    log.mockRestore();
  }
}

test("a refused callback logs its request id, resolved address and reason", async () => {
  for (const status of [302, 303])
    expect(
      await lines(
        "/auth/sso/callback?providerId=tenant",
        new Response(null, {
          status,
          headers: {
            location: "/error?error=directory_mismatch&error_description=x",
          },
        }),
        "198.51.100.7",
      ),
    ).toEqual([
      [
        "[id] auth",
        {
          level: "error",
          event: "signin_rejected",
          requestId: "request",
          ip: "198.51.100.7",
          reason: "directory_mismatch",
        },
      ],
    ]);
});

test("ignores other paths, non-redirects, missing locations and successful redirects", async () => {
  for (const [path, response] of [
    ["/auth/get-session", Response.redirect("https://example.com/?error=x")],
    ["/auth/sso/callback", new Response()],
    ["/auth/sso/callback", new Response(null, { status: 302 })],
    ["/auth/sso/callback", Response.redirect("https://example.com/success")],
  ] as const)
    expect(await lines(path, response)).toEqual([]);
});

for (const reported of ["private-token-value", "x".repeat(8192), ""]) {
  test(`an unknown callback error is not copied into the log (${reported.length})`, async () => {
    const location = new URL("https://example.com/error");
    location.searchParams.set("error", reported);
    location.searchParams.set("error_description", "private-upstream-token");
    const logged = await lines(
      "/auth/sso/callback",
      Response.redirect(location),
    );
    expect(logged).toEqual([
      [
        "[id] auth",
        {
          level: "error",
          event: "signin_rejected",
          requestId: "request",
          ip: null,
          reason: "sso_callback_failed",
        },
      ],
    ]);
    expect(JSON.stringify(logged)).not.toContain("private-upstream-token");
    if (reported) expect(JSON.stringify(logged)).not.toContain(reported);
  });
}
