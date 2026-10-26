import { describe, expect, test } from "bun:test"
import { hostsFor } from "./environments"
import { formatReport, runSmoke, smokePassed, type DeclaredMcp, type Fetch, type SmokeOptions } from "./smoke"

const hosts = hostsFor("staging")
/** An MCP in each place: the Toolbox's hub and its own URL, the hub alone, its own URL alone. */
const MCPS: DeclaredMcp[] = [{ name: "e2e", serve: "both" }, { name: "example", serve: "toolbox" }, { name: "solo", serve: "standalone" }]
const ISSUER = `https://${hosts.id}`
const url = (host: string, path: string) => `https://${host}${path}`

type Answer = Response | Error | ((attempt: number) => Response | Error)

/** Healthy answers for every URL the smoke test reads. */
function healthy(): Record<string, Answer> {
  return {
    [url(hosts.id, "/healthz")]: Response.json({ status: "ok" }),
    [url(hosts.id, "/readyz")]: Response.json({ status: "ok" }),
    [url(hosts.id, "/.well-known/openid-configuration")]: () =>
      Response.json({ issuer: ISSUER, jwks_uri: `${ISSUER}/auth/jwks` }),
    [url(hosts.id, "/auth/jwks")]: Response.json({ keys: [{ kid: "one" }, { kid: "two" }] }),
    [url(hosts.toolbox, "/health")]: Response.json({ status: "ok", databases: { toolbox: "ok", mcps: "ok" }, providers: ["example", "e2e", "solo"] }),
    [url(hosts.toolbox, "/.well-known/oauth-protected-resource/mcp")]: Response.json({
      resource: `https://${hosts.toolbox}/mcp`,
      authorization_servers: [ISSUER],
    }),
    [url(hosts.admin, "/health")]: Response.json({ status: "ok" }),
    [url(hosts.admin, "/.well-known/oauth-protected-resource/mcp")]: Response.json({
      resource: `https://${hosts.admin}/mcp`,
      authorization_servers: [ISSUER],
    }),
    ...Object.fromEntries(["e2e", "solo"].map((name) => [url(hosts.mcp, `/.well-known/oauth-protected-resource/${name}/mcp`), Response.json({ resource: `https://${hosts.mcp}/${name}/mcp`, authorization_servers: [ISSUER] })])),
  }
}

function harness(answers: Record<string, Answer>, overrides: Partial<SmokeOptions> = {}) {
  const attempts = new Map<string, number>()
  const requests: Array<{ url: string; init: RequestInit }> = []
  const sleeps: number[] = []
  let clock = 0
  const fetch: Fetch = async (target, init) => {
    requests.push({ url: target, init })
    const attempt = (attempts.get(target) ?? 0) + 1
    attempts.set(target, attempt)
    const answer = answers[target]
    if (answer === undefined) return new Response("not found", { status: 404 })
    const result = typeof answer === "function" ? answer(attempt) : answer
    if (result instanceof Error) throw result
    return result.clone()
  }
  const options: SmokeOptions = {
    fetch,
    sleep: async (ms) => {
      sleeps.push(ms)
      clock += ms
    },
    now: () => clock,
    timeoutMs: 10_000,
    intervalMs: 5_000,
    ...overrides,
  }
  return { options, requests, sleeps, attempts }
}

async function failures(answers: Record<string, Answer>) {
  const h = harness(answers, { timeoutMs: 0 })
  const results = await runSmoke(hosts, MCPS, h.options)
  return results.filter((result) => !result.ok).map((result) => `${result.name}: ${result.detail}`)
}

describe("runSmoke", () => {
  test("passes against a healthy environment and reads exactly the expected URLs", async () => {
    const h = harness(healthy())
    const results = await runSmoke(hosts, MCPS, h.options)
    expect(results.map((result) => result.name)).toEqual([
      "id /healthz",
      "id /readyz",
      "id discovery",
      "id jwks",
      "toolbox /health",
      "toolbox resource metadata",
      "admin-mcp /health",
      "admin-mcp resource metadata",
      "e2e resource metadata",
      "solo resource metadata",
    ])
    expect(results.every((result) => result.ok && result.attempts === 1)).toBe(true)
    expect(smokePassed(results)).toBe(true)
    expect(h.requests.map((request) => request.url)).toEqual([
      url(hosts.id, "/healthz"),
      url(hosts.id, "/readyz"),
      url(hosts.id, "/.well-known/openid-configuration"),
      url(hosts.id, "/.well-known/openid-configuration"),
      url(hosts.id, "/auth/jwks"),
      url(hosts.toolbox, "/health"),
      url(hosts.toolbox, "/.well-known/oauth-protected-resource/mcp"),
      url(hosts.admin, "/health"),
      url(hosts.admin, "/.well-known/oauth-protected-resource/mcp"),
      url(hosts.mcp, "/.well-known/oauth-protected-resource/e2e/mcp"),
      url(hosts.mcp, "/.well-known/oauth-protected-resource/solo/mcp"),
    ])
    expect(h.sleeps).toEqual([])
  })

  test("never follows a redirect, never caches, and gives every request a timeout", async () => {
    const h = harness(healthy())
    await runSmoke(hosts, MCPS, h.options)
    for (const { init } of h.requests) {
      expect(init.redirect).toBe("manual")
      expect(init.cache).toBe("no-store")
      expect(init.signal).toBeInstanceOf(AbortSignal)
      expect((init.headers as Record<string, string>).accept).toBe("application/json")
    }
  })

  test("describes what it found in the detail of a passing check", async () => {
    const results = await runSmoke(hosts, MCPS, harness(healthy()).options)
    const detail = Object.fromEntries(results.map((result) => [result.name, result.detail]))
    expect(detail["id /healthz"]).toBe('status "ok"')
    expect(detail["id discovery"]).toBe(`issuer ${ISSUER}`)
    expect(detail["id jwks"]).toBe("2 signing keys")
    expect(detail["toolbox resource metadata"]).toBe(`names ${ISSUER}`)
    expect(detail["toolbox /health"]).toBe('status "ok", 3 MCPs served')
  })

  test("with no MCP, the Toolbox serves none and nothing is asked of the mcp host", async () => {
    const h = harness({ ...healthy(), [url(hosts.toolbox, "/health")]: Response.json({ status: "ok", providers: [] }) })
    const results = await runSmoke(hosts, [], h.options)
    expect(smokePassed(results)).toBe(true)
    expect(results.find((result) => result.name === "toolbox /health")!.detail).toBe('status "ok", 0 MCPs served')
    expect(h.requests.some((request) => request.url.startsWith(`https://${hosts.mcp}/`))).toBe(false)
    const one = await runSmoke(hosts, [{ name: "example", serve: "toolbox" }], harness({ ...healthy(), [url(hosts.toolbox, "/health")]: Response.json({ status: "ok", providers: ["example"] }) }).options)
    expect(one.find((result) => result.name === "toolbox /health")!.detail).toBe('status "ok", 1 MCP served')
  })

  test("fails the Toolbox's health when it serves other MCPs than the list's, or names none", async () => {
    const health = url(hosts.toolbox, "/health")
    expect(await failures({ ...healthy(), [health]: Response.json({ status: "ok", providers: ["e2e"] }) })).toEqual([
      'toolbox /health: providers are ["e2e"], expected ["e2e","example","solo"]',
    ])
    expect(await failures({ ...healthy(), [health]: Response.json({ status: "ok" }) })).toEqual([
      'toolbox /health: providers are undefined, expected ["e2e","example","solo"]',
    ])
    expect(await failures({ ...healthy(), [health]: Response.json({ status: "unavailable", providers: ["e2e", "example", "solo"] }) })).toEqual([
      'toolbox /health: status is "unavailable", expected "ok"',
    ])
  })

  test("fails a standalone MCP whose metadata is missing or names another resource", async () => {
    expect(await failures({
      ...healthy(),
      [url(hosts.mcp, "/.well-known/oauth-protected-resource/e2e/mcp")]: Response.json({ resource: `https://${hosts.mcp}/mcp`, authorization_servers: [ISSUER] }),
      [url(hosts.mcp, "/.well-known/oauth-protected-resource/solo/mcp")]: new Response("not found", { status: 404 }),
    })).toEqual([
      `e2e resource metadata: resource is "https://${hosts.mcp}/mcp", expected https://${hosts.mcp}/e2e/mcp`,
      "solo resource metadata: HTTP 404",
    ])
  })

  test("says one signing key in the singular", async () => {
    const results = await runSmoke(hosts, MCPS, harness({ ...healthy(), [url(hosts.id, "/auth/jwks")]: Response.json({ keys: [{}] }) }).options)
    expect(results.find((result) => result.name === "id jwks")!.detail).toBe("1 signing key")
  })

  test("fails a check on a status other than 200, naming a redirect's target", async () => {
    const problems = await failures({
      ...healthy(),
      [url(hosts.id, "/healthz")]: new Response("", { status: 503 }),
      [url(hosts.id, "/readyz")]: new Response("", { status: 302, headers: { location: "https://elsewhere.example/" } }),
    })
    expect(problems).toEqual([
      "id /healthz: HTTP 503",
      "id /readyz: HTTP 302 redirecting to https://elsewhere.example/",
    ])
  })

  test("fails a check when nothing answers, a plain error and a thrown string alike", async () => {
    const problems = await failures({
      ...healthy(),
      [url(hosts.id, "/healthz")]: new Error("connect ECONNREFUSED"),
      [url(hosts.id, "/readyz")]: () => {
        throw "reset by peer"
      },
    })
    expect(problems).toEqual(["id /healthz: no answer: connect ECONNREFUSED", "id /readyz: no answer: reset by peer"])
  })

  test("adds the error code to a network failure when there is one", async () => {
    const problems = await failures({
      ...healthy(),
      [url(hosts.id, "/healthz")]: Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" }),
    })
    expect(problems).toEqual(["id /healthz: no answer: certificate has expired (CERT_HAS_EXPIRED)"])
  })

  test("fails a check on a body that is not a JSON object", async () => {
    const problems = await failures({
      ...healthy(),
      [url(hosts.id, "/healthz")]: new Response("<html>"),
      [url(hosts.id, "/readyz")]: Response.json([1, 2]),
      [url(hosts.toolbox, "/health")]: Response.json(null),
    })
    expect(problems).toEqual([
      "id /healthz: the body is not JSON",
      "id /readyz: the body is not a JSON object",
      "toolbox /health: the body is not a JSON object",
    ])
  })

  test("fails a health check whose status is not ok", async () => {
    const problems = await failures({
      ...healthy(),
      [url(hosts.admin, "/health")]: Response.json({ status: "unavailable" }),
    })
    expect(problems).toEqual(['admin-mcp /health: status is "unavailable", expected "ok"'])
  })

  test("fails discovery when the issuer is not the ID hostname", async () => {
    const problems = await failures({
      ...healthy(),
      [url(hosts.id, "/.well-known/openid-configuration")]: Response.json({ issuer: "http://localhost:47300" }),
    })
    expect(problems).toContain(`id discovery: issuer is "http://localhost:47300", expected ${ISSUER}`)
  })

  test("fails the JWKS check on a missing or foreign jwks_uri, an empty key set or a malformed one", async () => {
    const discovery = url(hosts.id, "/.well-known/openid-configuration")
    expect(await failures({ ...healthy(), [discovery]: Response.json({ issuer: ISSUER }) })).toContain(
      "id jwks: the discovery document has no jwks_uri",
    )
    expect(await failures({ ...healthy(), [discovery]: Response.json({ issuer: ISSUER, jwks_uri: "not a url" }) })).toContain(
      'id jwks: jwks_uri "not a url" is not a URL',
    )
    expect(
      await failures({ ...healthy(), [discovery]: Response.json({ issuer: ISSUER, jwks_uri: "https://elsewhere.example/jwks" }) }),
    ).toContain(`id jwks: jwks_uri https://elsewhere.example/jwks is not under ${ISSUER}`)
    expect(await failures({ ...healthy(), [url(hosts.id, "/auth/jwks")]: Response.json({ keys: [] }) })).toContain(
      "id jwks: the key set is empty",
    )
    expect(await failures({ ...healthy(), [url(hosts.id, "/auth/jwks")]: Response.json({ keys: "none" }) })).toContain(
      "id jwks: the key set is empty",
    )
  })

  test("fails resource metadata that names another resource or another issuer", async () => {
    const problems = await failures({
      ...healthy(),
      [url(hosts.toolbox, "/.well-known/oauth-protected-resource/mcp")]: Response.json({
        resource: "http://localhost:47400/mcp",
        authorization_servers: [ISSUER],
      }),
      [url(hosts.admin, "/.well-known/oauth-protected-resource/mcp")]: Response.json({
        resource: `https://${hosts.admin}/mcp`,
        authorization_servers: ["https://id.answerable.org"],
      }),
    })
    expect(problems).toEqual([
      `toolbox resource metadata: resource is "http://localhost:47400/mcp", expected https://${hosts.toolbox}/mcp`,
      `admin-mcp resource metadata: authorization_servers is ["https://id.answerable.org"], expected it to name ${ISSUER}`,
    ])
    const missing = await failures({
      ...healthy(),
      [url(hosts.admin, "/.well-known/oauth-protected-resource/mcp")]: Response.json({ resource: `https://${hosts.admin}/mcp` }),
    })
    expect(missing).toEqual([
      `admin-mcp resource metadata: authorization_servers is undefined, expected it to name ${ISSUER}`,
    ])
  })

  test("retries a failing check until it passes", async () => {
    const h = harness({
      ...healthy(),
      [url(hosts.id, "/readyz")]: (attempt) => (attempt < 3 ? new Response("", { status: 503 }) : Response.json({ status: "ok" })),
    })
    const results = await runSmoke(hosts, MCPS, h.options)
    const readyz = results.find((result) => result.name === "id /readyz")!
    expect(readyz).toMatchObject({ ok: true, attempts: 3, ms: 10_000 })
    expect(h.sleeps).toEqual([5_000, 5_000])
    expect(smokePassed(results)).toBe(true)
  })

  test("gives up when the next retry would pass the deadline, and shares the deadline between checks", async () => {
    const h = harness({
      ...healthy(),
      [url(hosts.id, "/healthz")]: new Response("", { status: 503 }),
      [url(hosts.id, "/readyz")]: new Response("", { status: 503 }),
    })
    const results = await runSmoke(hosts, MCPS, h.options)
    const healthz = results.find((result) => result.name === "id /healthz")!
    const readyz = results.find((result) => result.name === "id /readyz")!
    expect(healthz).toMatchObject({ ok: false, attempts: 3, detail: "HTTP 503" })
    expect(readyz).toMatchObject({ ok: false, attempts: 1 })
    expect(smokePassed(results)).toBe(false)
  })

  test("makes a single attempt per check when the timeout is zero", async () => {
    const h = harness({ ...healthy(), [url(hosts.id, "/healthz")]: new Response("", { status: 500 }) }, { timeoutMs: 0 })
    const results = await runSmoke(hosts, MCPS, h.options)
    expect(results.find((result) => result.name === "id /healthz")!.attempts).toBe(1)
    expect(h.sleeps).toEqual([])
  })

  test("uses the production hostnames for production", async () => {
    const production = hostsFor("production")
    const h = harness({}, { timeoutMs: 0 })
    await runSmoke(production, MCPS, h.options)
    expect(h.requests[0]!.url).toBe("https://id.answerable.org/healthz")
    expect(h.requests.at(-1)!.url).toBe("https://mcp.answerable.org/.well-known/oauth-protected-resource/solo/mcp")
  })

  test("abandons a request that outlives the request timeout", async () => {
    const hanging: Fetch = (_target, init) =>
      new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))
    const results = await runSmoke(hosts, MCPS, { ...harness({}).options, fetch: hanging, timeoutMs: 0, requestTimeoutMs: 5 })
    expect(results).toHaveLength(10)
    expect(results.every((result) => !result.ok && result.detail.startsWith("no answer: "))).toBe(true)
  })
})

describe("formatReport", () => {
  test("prints a table with a row per check and a summary", async () => {
    const h = harness({ ...healthy(), [url(hosts.id, "/healthz")]: new Response("", { status: 503 }) }, { timeoutMs: 0 })
    const results = await runSmoke(hosts, MCPS, h.options)
    const report = formatReport("staging", hosts, results)
    const lines = report.split("\n")
    expect(lines[0]).toBe("Smoke test of staging: id.answerable-staging.uk, toolbox.answerable-staging.uk, admin-mcp.answerable-staging.uk, mcp.answerable-staging.uk")
    expect(lines[2]).toMatch(/^CHECK\s+RESULT\s+TIME\s+TRIES\s+DETAIL$/)
    expect(lines[3]).toMatch(/^id \/healthz\s+FAIL\s+0 ms\s+1\s+HTTP 503$/)
    expect(lines[4]).toMatch(/^id \/readyz\s+PASS\s+0 ms\s+1\s+status "ok"$/)
    expect(lines.at(-2)).toBe("FAILED: 1 of 10 checks failed")
  })

  test("says when everything passed", async () => {
    const results = await runSmoke(hosts, MCPS, harness(healthy()).options)
    expect(formatReport("staging", hosts, results)).toContain("PASSED: 10 of 10 checks")
  })
})
