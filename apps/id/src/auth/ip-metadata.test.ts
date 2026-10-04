import type { BetterAuthOptions } from "better-auth";
import { afterAll, expect, test } from "bun:test";
import { createAuth } from "../auth.ts";
import { createDatabase } from "../db/client.ts";
import { testEnvironment } from "../__tests__/support.ts";
const environment = testEnvironment({ trustedProxyCidrs: ["10.0.0.0/8"] });
const connection = createDatabase(environment);
afterAll(() => connection.close());

for (const spoof of [false, true])
  test(
    spoof
      ? "spoofed leftmost forwarding entries cannot change the native rate-limit key"
      : "distinct clients have distinct native rate-limit keys",
    async () => {
      const auth = createAuth(connection.db, environment);
      const context = await auth.$context;
      context.rateLimit.enabled = true;
      context.rateLimit.max = 1;
      const keys: string[] = [];
      const counts = new Map<string, number>();
      const options: BetterAuthOptions = context.options;
      options.rateLimit = {
        customStorage: {
          consume: async (key, rule) => {
            keys.push(key);
            const count = (counts.get(key) ?? 0) + 1;
            counts.set(key, count);
            return count <= rule.max
              ? { allowed: true, retryAfter: null }
              : { allowed: false, retryAfter: rule.window };
          },
        },
      };
      for (const [index, address] of ["192.0.2.1", "198.51.100.7"].entries()) {
        const response = await auth.handler(
          new Request(`${environment.betterAuthUrl}/auth/ok`, {
            headers: {
              "x-forwarded-for": `${address}, ${spoof ? "203.0.113.5, " : ""}10.0.0.1`,
            },
          }),
        );
        expect(response.status).toBe(spoof && index === 1 ? 429 : 200);
      }
      expect(keys).toHaveLength(2);
      expect(keys[0] === keys[1]).toBe(spoof);
    },
  );

for (const path of [
  "/auth/ok",
  "/api/admin/v1/me",
  "/login",
  "/assets/tailwind.css",
  "/healthz",
  "/readyz",
])
  test(`production ingress admission at ${path}`, async () => {
    // Better Auth captures NODE_ENV at module load, so production needs a fresh process.
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
    import { createApp } from "./src/app.ts";
    import { stubAuth, stubDatabase, testEnvironment } from "./src/__tests__/support.ts";
    let calls = 0;
    const auth = { ...stubAuth(), handler: () => { calls++; return Response.json({ ok: true }); } };
    const app = createApp({ db: { ...stubDatabase(), execute: async () => ({ rows: [] }) }, auth, environment: testEnvironment({ nodeEnv: "production" }) });
    const response = await app.request(${JSON.stringify(path)}, { headers: { "x-request-id": "ingress-test" } });
    console.log(JSON.stringify({ status: response.status, body: await response.json(), headers: Object.fromEntries(response.headers), calls }));
  `,
      ],
      {
        cwd: import.meta.dir + "/../..",
        env: { ...process.env, NODE_ENV: "production", TEST: "" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const result = JSON.parse(await new Response(child.stdout).text());
    expect(await child.exited).toBe(0);
    expect(result.calls).toBe(0);
    expect(result.headers["x-request-id"]).toBe("ingress-test");
    if (path === "/healthz" || path === "/readyz")
      expect(result.status).toBe(200);
    else {
      expect(result.status).toBe(403);
      expect(result.body).toEqual({ error: "untrusted_ingress" });
      expect(result.headers["cache-control"]).toBe("no-store");
    }
  });

// The process-level checks above exercise the native resolver in production;
// this isolates the app's admission branch for in-process coverage.
test("unresolved client context refuses authentication before dispatch", async () => {
  const { createApp } = await import("../app.ts");
  const { stubAuth } = await import("../__tests__/support.ts");
  const auth = stubAuth();
  const options: BetterAuthOptions = auth.options;
  options.advanced = {
    ...auth.options.advanced,
    ipAddress: { disableIpTracking: true },
  };
  const app = createApp({
    db: connection.db,
    auth,
    environment: { ...environment, nodeEnv: "production" },
  });
  expect((await app.request("/auth/ok")).status).toBe(403);
});

test("production rate-limits token requests per client address", async () => {
  // Better Auth enables its limiter from NODE_ENV at module load, so production needs a fresh process.
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
    import { createApp } from "./src/app.ts";
    import { createAuth } from "./src/auth.ts";
    import { createDatabase } from "./src/db/client.ts";
    import { testEnvironment } from "./src/__tests__/support.ts";
    const environment = testEnvironment({ nodeEnv: "production", trustedProxyCidrs: ["10.0.0.0/8"] });
    const connection = createDatabase(environment);
    const app = createApp({ auth: createAuth(connection.db, environment), db: connection.db, environment });
    const token = (client) => app.request("/auth/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": client + ", 10.0.0.1" },
      body: "grant_type=client_credentials",
    });
    const statuses = [];
    for (let attempt = 0; attempt < 21; attempt++) statuses.push((await token("198.51.100.7")).status);
    const other = (await token("192.0.2.1")).status;
    await connection.close();
    console.log(JSON.stringify({ statuses, other }));
  `,
    ],
    {
      cwd: import.meta.dir + "/../..",
      env: { ...process.env, NODE_ENV: "production", TEST: "" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const result = JSON.parse(await new Response(child.stdout).text());
  expect(await child.exited).toBe(0);
  // The default burst for the token endpoint is 20 requests a minute.
  expect(result.statuses).toEqual([...Array(20).fill(400), 429]);
  expect(result.other).toBe(400);
});
