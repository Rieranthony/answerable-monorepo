import type { BetterAuthOptions } from "better-auth";
import { afterAll, expect, test } from "bun:test";
import { createApp } from "../app.ts";
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
          new Request(`${environment.betterAuthUrl}/auth/get-session`, {
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

// Each request is counted against the key of the client address it resolves
// to; a limit of one makes a repeated key answer 429.
async function sendCounted(
  requests: Record<string, string>[],
  send: (
    auth: ReturnType<typeof createAuth>,
    headers: Record<string, string>,
  ) => Response | Promise<Response>,
) {
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
  const statuses: number[] = [];
  for (const headers of requests)
    statuses.push((await send(auth, headers)).status);
  return { keys, statuses };
}
const direct = (
  auth: ReturnType<typeof createAuth>,
  headers: Record<string, string>,
) =>
  auth.handler(
    new Request(`${environment.betterAuthUrl}/auth/get-session`, { headers }),
  );
// The sign-in pages call the service in-process and pass the headers on.
const throughPages = (
  auth: ReturnType<typeof createAuth>,
  headers: Record<string, string>,
) =>
  createApp({ auth, db: connection.db, environment }).request("/login", {
    headers,
  });

for (const [name, send] of [
  ["the service", direct],
  ["the sign-in pages", throughPages],
] as const) {
  const clientKey = (address: string) => expect.stringContaining(address);
  test(`${name}: cf-connecting-ip decides the client address over X-Forwarded-For`, async () => {
    // Rotating forwarded entries cannot move a client to a new key, and
    // another client behind the same forwarded entries gets its own.
    const { keys, statuses } = await sendCounted(
      [
        {
          "cf-connecting-ip": "198.51.100.7",
          "x-forwarded-for": "192.0.2.1, 10.0.0.1",
        },
        {
          "cf-connecting-ip": "198.51.100.7",
          "x-forwarded-for": "192.0.2.2, 10.0.0.1",
        },
        {
          "cf-connecting-ip": "198.51.100.7",
          "x-forwarded-for": "203.0.113.9, 10.0.0.1",
        },
        {
          "cf-connecting-ip": "198.51.100.8",
          "x-forwarded-for": "192.0.2.1, 10.0.0.1",
        },
      ],
      send,
    );
    expect(keys).toHaveLength(4);
    expect(keys[0]).toEqual(clientKey("198.51.100.7"));
    expect(new Set(keys.slice(0, 3)).size).toBe(1);
    expect(keys[3]).toEqual(clientKey("198.51.100.8"));
    expect(keys[3]).not.toBe(keys[0]);
    // The pages answer 200 whatever the service says to their session read.
    if (send === direct)
      expect(statuses.map((status) => status === 429)).toEqual([
        false,
        true,
        true,
        false,
      ]);
  });

  test(`${name}: without cf-connecting-ip, or when it names no client, the forwarded walk decides`, async () => {
    const { keys } = await sendCounted(
      [
        { "x-forwarded-for": "192.0.2.1, 10.0.0.1" },
        // A proxy address, a malformed value and an empty one name no client.
        {
          "cf-connecting-ip": "10.0.0.7",
          "x-forwarded-for": "192.0.2.1, 10.0.0.1",
        },
        {
          "cf-connecting-ip": "not-an-address",
          "x-forwarded-for": "192.0.2.1, 10.0.0.1",
        },
        { "cf-connecting-ip": "", "x-forwarded-for": "192.0.2.1, 10.0.0.1" },
        { "x-forwarded-for": "198.51.100.7, 10.0.0.1" },
      ],
      send,
    );
    expect(keys).toHaveLength(5);
    expect(keys[0]).toEqual(clientKey("192.0.2.1"));
    expect(new Set(keys.slice(0, 4)).size).toBe(1);
    expect(keys[4]).toEqual(clientKey("198.51.100.7"));
  });
}

for (const path of [
  "/auth/get-session",
  "/api/admin/v1/me",
  "/login",
  "/magic-link",
  "/magic-link/code",
  "/connect-directory",
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
  expect((await app.request("/auth/get-session")).status).toBe(403);
});

// An office signs in through one egress address and a server-side host refreshes
// every user's token from one address, so each route class allows a burst sized
// for that, per client address and per process.
for (const { route, limit, request } of [
  {
    route: "POST /auth/sign-in/sso",
    limit: 60,
    request: `{ path: "/auth/sign-in/sso", method: "POST", headers: { "content-type": "application/json", origin: environment.betterAuthUrl }, body: JSON.stringify({ email: "person@example.com", callbackURL: environment.betterAuthUrl + "/" }) }`,
  },
  {
    route: "GET /auth/sso/callback",
    limit: 300,
    request: `{ path: "/auth/sso/callback?state=x&code=y" }`,
  },
  {
    route: "GET /auth/oauth2/authorize",
    limit: 300,
    request: `{ path: "/auth/oauth2/authorize?client_id=x&response_type=code" }`,
  },
  {
    route: "POST /auth/oauth2/token",
    limit: 600,
    request: `{ path: "/auth/oauth2/token", method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" }`,
  },
])
  test(`production allows ${limit} ${route} requests per client address`, async () => {
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
    const send = async (client) => {
      const { path, method, headers, body } = ${request};
      const response = await app.request(path, { method, body, headers: { ...headers, "x-forwarded-for": client + ", 10.0.0.1" } });
      await response.arrayBuffer();
      return response.status;
    };
    const statuses = [];
    for (let attempt = 0; attempt <= ${limit}; attempt++) statuses.push(await send("198.51.100.7"));
    const other = await send("192.0.2.1");
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
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    const { statuses, other } = JSON.parse(output) as {
      statuses: number[];
      other: number;
    };
    expect(statuses.slice(0, limit)).not.toContain(429);
    expect(statuses[limit]).toBe(429);
    expect(other).not.toBe(429);
  }, 60_000);
