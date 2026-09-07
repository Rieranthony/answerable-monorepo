import dns from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { expect, test, spyOn, beforeEach, afterEach } from "bun:test";
import type { Database } from "../db/client.ts";
import { testSsoProvider, type SsoTestOptions } from "./sso-test.ts";

const resolver = dns as {
  lookup: (host: string, options: { all: true }) => Promise<LookupAddress[]>;
};
let lookup: ReturnType<typeof spyOn<typeof resolver, "lookup">>;
beforeEach(() => {
  lookup = spyOn(resolver, "lookup");
  lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
});
afterEach(() => {
  lookup.mockRestore();
});

const issuer = "https://id.example.com";
const discovery = {
  issuer,
  authorization_endpoint: `${issuer}/authorize`,
  token_endpoint: `${issuer}/token`,
  jwks_uri: `${issuer}/jwks`,
};
function database(
  issuerValue = issuer,
  discoveryEndpoint?: string,
  missing = false,
): Database {
  const rows = missing
    ? []
    : [
        {
          issuer: issuerValue,
          oidcConfig: JSON.stringify({ discoveryEndpoint }),
        },
      ];
  return {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => rows }) }),
    }),
  } as unknown as Database;
}
function fetchResponses(...responses: (Response | Error)[]): typeof fetch {
  return (async (_url: unknown, options: RequestInit) => {
    expect(options.redirect).toBe("manual");
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.headers).toBeUndefined();
    const response = responses.shift();
    if (response instanceof Error) throw response;
    if (!response) throw new Error("Unexpected request");
    return response;
  }) as typeof fetch;
}
function json(value: unknown) {
  return Response.json(value);
}
const keys = () => json({ keys: [{ kty: "RSA", kid: "test" }] });
async function run(
  responses: (Response | Error)[],
  options: SsoTestOptions = {},
  db = database(),
) {
  return testSsoProvider(db, "org", {
    fetch: fetchResponses(...responses),
    ...options,
  });
}
function codes(result: Awaited<ReturnType<typeof testSsoProvider>>) {
  return result.problems.map((problem) => problem.code);
}

test("passing discovery, exact issuer and JWKS without credentials", async () => {
  const result = await run([json(discovery), keys()]);
  expect(result).toMatchObject({
    issuer,
    kind: "oidc",
    discovery: {
      url: `${issuer}/.well-known/openid-configuration`,
      reachable: true,
      status: 200,
      issuerMatches: true,
      authorizationEndpoint: discovery.authorization_endpoint,
      tokenEndpoint: discovery.token_endpoint,
      jwksUri: discovery.jwks_uri,
    },
    jwks: { reachable: true, keys: 1 },
    problems: [],
  });
  expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
});
test("provider not found is a 404", async () => {
  await expect(
    testSsoProvider(database(issuer, undefined, true), "org"),
  ).rejects.toMatchObject({ status: 404, code: "provider_not_found" });
});
test("uses configured discovery URL", async () => {
  const custom = `${issuer}/metadata`;
  const result = await run(
    [json(discovery), keys()],
    {},
    database(issuer, custom),
  );
  expect(result.discovery.url).toBe(custom);
});
test("rejects malformed and insecure issuer and discovery URLs", async () => {
  for (const value of [
    "not a URL",
    "http://public.example.com",
    "ftp://127.0.0.1",
  ]) {
    expect(
      codes(await run([], { allowPrivateHosts: true }, database(value))),
    ).toEqual(["insecure_issuer"]);
  }
  expect(
    codes(await run([], {}, database(issuer, "http://other.example.com"))),
  ).toEqual(["insecure_issuer"]);
});
test("refuses private addresses and hostnames by default", async () => {
  for (const host of [
    "127.0.0.1",
    "127.1",
    "10.2.3.4",
    "172.16.1.2",
    "172.31.255.255",
    "192.168.1.2",
    "169.254.169.254",
    "0.0.0.0",
    "[::1]",
    "[::]",
    "[fc00::1]",
    "[fe80::1]",
    "[::ffff:127.0.0.1]",
    "localhost",
    "a.localhost",
    "local",
    "a.local",
    "internal",
    "a.internal",
    "a.local.",
  ]) {
    expect(codes(await run([], {}, database(`https://${host}`))), host).toEqual(
      ["private_host"],
    );
  }
  expect(
    codes(await run([], {}, database(issuer, "https://10.0.0.1/discovery"))),
  ).toEqual(["private_host"]);
});
test("private test issuers can use HTTP with explicit option", async () => {
  const local = "http://127.0.0.1:4321";
  const result = await run(
    [json({ ...discovery, issuer: local, jwks_uri: `${local}/jwks` }), keys()],
    { allowPrivateHosts: true },
    database(local),
  );
  expect(result.problems).toEqual([]);
});
test("allows public IP literals", async () => {
  for (const host of ["8.8.8.8", "[2606:4700:4700::1111]"]) {
    const value = `https://${host}`;
    expect(
      codes(
        await run(
          [json({ ...discovery, issuer: value }), keys()],
          {},
          database(value),
        ),
      ),
    ).toEqual([]);
  }
});
test("discovery network errors, HTTP errors and redirects are unreachable", async () => {
  for (const response of [
    new Error("offline"),
    new Response(null, { status: 503 }),
    new Response(null, {
      status: 302,
      headers: { Location: "https://127.0.0.1" },
    }),
  ]) {
    const result = await run([response]);
    expect(codes(result)).toEqual(["discovery_unreachable"]);
    expect(result.discovery.reachable).toBe(false);
    expect(result.discovery.status).toBe(
      response instanceof Response ? response.status : null,
    );
  }
});
test("timeout aborts the request", async () => {
  const fetcher = ((_url: unknown, options: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      options.signal!.addEventListener(
        "abort",
        () => reject(options.signal!.reason),
        { once: true },
      );
    })) as typeof fetch;
  expect(
    codes(
      await testSsoProvider(database(), "org", {
        fetch: fetcher,
        timeoutMs: 1,
      }),
    ),
  ).toEqual(["discovery_unreachable"]);
});
test("discovery requires all fields and valid bounded JSON", async () => {
  for (const field of Object.keys(discovery)) {
    const body: Record<string, string> = { ...discovery };
    delete body[field];
    expect(codes(await run([json(body)]))).toEqual(["discovery_invalid"]);
  }
  for (const response of [
    new Response(null),
    new Response("{"),
    new Response(" ".repeat(256 * 1024 + 1)),
    json({ ...discovery, jwks_uri: "invalid" }),
  ]) {
    expect(codes(await run([response]))).toEqual(["discovery_invalid"]);
  }
});
test("accepts exactly 256 KiB and reads multiple chunks", async () => {
  const body = JSON.stringify(discovery).padEnd(256 * 1024, " ");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body.slice(0, 100)));
      controller.enqueue(new TextEncoder().encode(body.slice(100)));
      controller.close();
    },
  });
  expect(codes(await run([new Response(stream), keys()]))).toEqual([]);
});
test("issuer mismatch still inspects JWKS", async () => {
  const result = await run([
    json({ ...discovery, issuer: `${issuer}/wrong` }),
    keys(),
  ]);
  expect(codes(result)).toEqual(["issuer_mismatch"]);
  expect(result.discovery.issuerMatches).toBe(false);
  expect(result.jwks.keys).toBe(1);
});
test("JWKS URL cannot bypass endpoint safety", async () => {
  for (const [url, code] of [
    ["https://127.0.0.1/jwks", "private_host"],
    ["http://public.example.com/jwks", "insecure_issuer"],
  ] as const) {
    const result = await run([json({ ...discovery, jwks_uri: url })]);
    expect(codes(result)).toEqual([code!]);
    expect(result.jwks.reachable).toBe(false);
  }
});
test("JWKS errors and redirects are unreachable", async () => {
  for (const response of [
    new Error("offline"),
    new Response(null, { status: 500 }),
    new Response(null, { status: 307 }),
  ]) {
    expect(codes(await run([json(discovery), response]))).toEqual([
      "jwks_unreachable",
    ]);
  }
});
test("JWKS must be a bounded JSON key array", async () => {
  for (const response of [
    json({}),
    json({ keys: "wrong" }),
    json({ keys: [{}] }),
    new Response("{"),
    new Response("x".repeat(256 * 1024 + 1)),
  ]) {
    const result = await run([json(discovery), response]);
    expect(codes(result)).toEqual(["jwks_invalid"]);
    expect(result.jwks).toEqual({ reachable: true, keys: null });
  }
  expect((await run([json(discovery), json({ keys: [] })])).jwks.keys).toBe(0);
});
test("uses the default fetch when none is injected", async () => {
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(
    fetchResponses(json(discovery), keys()),
  );
  try {
    expect((await testSsoProvider(database(), "org")).problems).toEqual([]);
  } finally {
    fetcher.mockRestore();
  }
});

test("refuses DNS names resolving to private discovery or JWKS addresses", async () => {
  lookup.mockResolvedValueOnce([{ address: "10.0.0.1", family: 4 }]);
  expect(codes(await run([]))).toEqual(["private_host"]);
  lookup.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]);
  lookup.mockResolvedValueOnce([{ address: "::1", family: 6 }]);
  expect(codes(await run([json(discovery)]))).toEqual(["private_host"]);
});
test("DNS failures are unreachable", async () => {
  lookup.mockRejectedValueOnce(new Error("NXDOMAIN"));
  expect(codes(await run([]))).toEqual(["discovery_unreachable"]);
});
