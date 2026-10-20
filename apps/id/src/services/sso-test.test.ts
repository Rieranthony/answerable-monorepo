import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { testSsoProvider, type SsoTestOptions } from "./sso-test.ts";

const issuer = "https://id.example.com";
const discovery = {
  issuer,
  authorization_endpoint: `${issuer}/authorize`,
  token_endpoint: `${issuer}/token`,
  jwks_uri: `${issuer}/jwks`,
};
const trusted: SsoTestOptions = { trustedOrigins: [issuer] };
const keys = () => Response.json({ keys: [{ kty: "RSA", kid: "test" }] });

// Sign-in's discovery and the JWKS fetch both use the global fetch.
let answers: (Response | Error)[] = [];
let requested: string[] = [];
let fetcher: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
beforeEach(() => {
  answers = [];
  requested = [];
  fetcher = spyOn(globalThis, "fetch").mockImplementation((async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    requested.push(String(url));
    expect(init?.redirect).toBe("manual");
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    if (!answer) throw new Error("Unexpected request");
    return answer;
  }) as typeof fetch);
});
afterEach(() => fetcher.mockRestore());

async function run(
  responses: (Response | Error)[],
  options: SsoTestOptions = trusted,
  snapshot: { issuer: string; discoveryEndpoint?: string } = { issuer },
) {
  answers = responses;
  return testSsoProvider(snapshot, options);
}
const codes = (result: Awaited<ReturnType<typeof testSsoProvider>>) =>
  result.problems.map((problem) => problem.code);

test("passing discovery, issuer and JWKS, without credentials", async () => {
  const result = await run([Response.json(discovery), keys()]);
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
  expect(requested).toEqual([result.discovery.url, discovery.jwks_uri]);
});

test("uses the configured discovery URL", async () => {
  const custom = `${issuer}/metadata`;
  const result = await run([Response.json(discovery), keys()], trusted, {
    issuer,
    discoveryEndpoint: custom,
  });
  expect(result.discovery.url).toBe(custom);
  expect(requested[0]).toBe(custom);
});

test("an issuer with a trailing slash passes, as sign-in accepts it", async () => {
  const result = await run([Response.json(discovery), keys()], trusted, {
    issuer: `${issuer}/`,
  });
  expect(result.problems).toEqual([]);
  expect(result.discovery.url).toBe(
    `${issuer}/.well-known/openid-configuration`,
  );
});

test("an untrusted discovery URL or discovered endpoint stops discovery", async () => {
  const untrusted = await run([], { trustedOrigins: [] });
  expect(codes(untrusted)).toEqual(["untrusted_origin"]);
  expect(requested).toEqual([]);
  const endpoint = await run([
    Response.json({ ...discovery, token_endpoint: "https://other.example/t" }),
  ]);
  expect(codes(endpoint)).toEqual(["untrusted_origin"]);
  expect(endpoint.jwks.reachable).toBe(false);
});

test("a malformed or non-HTTP URL is insecure", async () => {
  for (const value of ["not a URL", "ftp://id.example.com"])
    expect(
      codes(await run([], { trustedOrigins: [value] }, { issuer: value })),
    ).toEqual(["insecure_issuer"]);
});

test("network errors, HTTP errors, redirects and timeouts are unreachable", async () => {
  for (const [answer, status] of [
    [new Error("offline"), null],
    [new Response(null, { status: 404 }), 404],
    [new Response(null, { status: 503 }), 503],
    [
      new Response(null, {
        status: 302,
        headers: { Location: "https://127.0.0.1" },
      }),
      302,
    ],
  ] as const) {
    const result = await run([answer]);
    expect(codes(result)).toEqual(["discovery_unreachable"]);
    expect(result.discovery).toMatchObject({ reachable: false, status });
  }
  fetcher.mockImplementation(
    ((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) =>
        init!.signal!.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        ),
      )) as typeof fetch,
  );
  expect(
    codes(await testSsoProvider({ issuer }, { ...trusted, timeoutMs: 1 })),
  ).toEqual(["discovery_unreachable"]);
});

test("discovery must be JSON naming the issuer and its endpoints", async () => {
  for (const field of Object.keys(discovery)) {
    const body: Record<string, string> = { ...discovery };
    delete body[field];
    const result = await run([Response.json(body)]);
    expect(codes(result), field).toEqual(["discovery_invalid"]);
    expect(result.discovery.reachable).toBe(true);
  }
  expect(codes(await run([new Response("{")]))).toEqual(["discovery_invalid"]);
  // The plugin throws a TypeError on an endpoint that is not a string.
  expect(
    codes(await run([Response.json({ ...discovery, token_endpoint: 1 })])),
  ).toEqual(["discovery_invalid"]);
});

test("a different issuer is a mismatch, and JWKS is not fetched", async () => {
  const result = await run([
    Response.json({ ...discovery, issuer: `${issuer}/wrong` }),
  ]);
  expect(codes(result)).toEqual(["issuer_mismatch"]);
  expect(result.discovery).toMatchObject({
    reachable: true,
    issuerMatches: false,
  });
  expect(result.jwks.reachable).toBe(false);
});

test("JWKS errors and redirects are unreachable", async () => {
  for (const answer of [
    new Error("offline"),
    new Response(null, { status: 500 }),
    new Response(null, { status: 307 }),
  ])
    expect(codes(await run([Response.json(discovery), answer]))).toEqual([
      "jwks_unreachable",
    ]);
});

test("JWKS must be a JSON key array", async () => {
  for (const answer of [
    Response.json({}),
    Response.json({ keys: "wrong" }),
    Response.json({ keys: [{}] }),
    new Response("{"),
  ]) {
    const result = await run([Response.json(discovery), answer]);
    expect(codes(result)).toEqual(["jwks_invalid"]);
    expect(result.jwks).toEqual({ reachable: true, keys: null });
  }
  expect(
    (await run([Response.json(discovery), Response.json({ keys: [] })])).jwks
      .keys,
  ).toBe(0);
});
