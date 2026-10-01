import { afterAll, expect, test } from "bun:test"
import { createAdmin, registerMachine, registerResource, setSsoProvider, type Admin } from "./admin"
import type { Spare } from "./id"

const requests: Request[] = []
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    requests.push(request.clone())
    const { pathname } = new URL(request.url)
    if (pathname.endsWith("/empty")) return new Response(null, { status: 204 })
    return pathname.endsWith("/refused") ? new Response("Not allowed here", { status: 403 }) : Response.json({ echoed: await request.text() })
  },
})
afterAll(() => server.stop(true))
const admin = createAdmin({ idOrigin: server.url.origin, rootSecret: "root-secret" })

test("admin calls ID's admin API as root with a fresh idempotency key each time, and returns the JSON body", async () => {
  expect(await admin("POST", "/organizations", { slug: "acme" })).toEqual({ echoed: JSON.stringify({ slug: "acme" }) })
  await admin("PUT", "/clients/x/resources/y")
  const [post, put] = requests
  expect(post!.url).toBe(`${server.url.origin}/api/admin/v1/organizations`)
  expect(post!.headers.get("authorization")).toBe("Bearer root-secret")
  expect(post!.headers.get("content-type")).toBe("application/json")
  expect(put!.headers.get("content-type")).toBeNull()
  expect(post!.headers.get("idempotency-key")).not.toBe(put!.headers.get("idempotency-key"))
})

test("a 204 answers an empty object", async () => {
  expect(await admin("DELETE", "/empty")).toEqual({})
})

test("a status outside 2xx throws with the method, path, status and body", async () => {
  await expect(admin("DELETE", "/refused")).rejects.toThrow("DELETE /refused returned 403: Not allowed here")
})

test("registerResource adds offline_access to the allowed scopes once", async () => {
  const bodies: unknown[] = []
  const fake: Admin = async (_method, _path, body) => {
    bodies.push(body)
    return {}
  }
  await registerResource(fake, { identifier: "https://mcp.test/mcp", scopes: ["e2e:read"], accessTokenTtl: 60 })
  await registerResource(fake, { identifier: "https://toolbox.test/mcp", scopes: ["offline_access", "toolbox"], accessTokenTtl: 60 })
  expect(bodies.map(body => (body as { allowedScopes: string[] }).allowedScopes)).toEqual([["e2e:read", "offline_access"], ["offline_access", "toolbox"]])
})

/** An `Admin` that records its calls and answers a machine client's secret. */
function recorder() {
  const calls: { method: string; path: string; body?: unknown }[] = []
  const fake: Admin = async (method, path, body) => {
    calls.push({ method, path, body })
    return { clientSecret: "shown-once" }
  }
  return { calls, fake }
}

test("registerMachine creates the client with the union of the scopes, links and approves each audience with its own scopes, and returns the client id and secret", async () => {
  const { calls, fake } = recorder()
  const machine = await registerMachine(fake, "org-1", "admin-mcp", { "https://id.test/api/admin": ["platform:read", "platform:write"], "https://toolbox.test/admin": ["toolbox:admin", "platform:read"] })
  expect(machine).toEqual({ clientId: "admin-mcp", clientSecret: "shown-once" })
  expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
    "POST /clients",
    `PUT /clients/admin-mcp/resources/${encodeURIComponent("https://id.test/api/admin")}`,
    "POST /organizations/org-1/capabilities",
    `PUT /clients/admin-mcp/resources/${encodeURIComponent("https://toolbox.test/admin")}`,
    "POST /organizations/org-1/capabilities",
  ])
  expect(calls[0]!.body).toEqual({
    clientId: "admin-mcp",
    name: "admin-mcp",
    organizationId: "org-1",
    tokenEndpointAuthMethod: "client_secret_basic",
    grantTypes: ["client_credentials"],
    clientCredentialsScopes: ["platform:read", "platform:write", "toolbox:admin"],
  })
  expect(calls[2]!.body).toEqual({ clientId: "admin-mcp", resource: "https://id.test/api/admin", grantKind: "client_credentials", scopes: ["platform:read", "platform:write"] })
  expect(calls[4]!.body).toEqual({ clientId: "admin-mcp", resource: "https://toolbox.test/admin", grantKind: "client_credentials", scopes: ["toolbox:admin", "platform:read"] })
})

test("setSsoProvider puts the spare directory's own-credentials provider", async () => {
  const { calls, fake } = recorder()
  const spare: Spare = {
    slug: "spare",
    domain: "spare.example.test",
    email: "tester@spare.example.test",
    issuer: "http://127.0.0.1:50001",
    authorizationEndpoint: "http://127.0.0.1:50001/authorize",
    tokenEndpoint: "http://127.0.0.1:50001/token",
    jwksEndpoint: "http://127.0.0.1:50001/jwks",
    clientId: "spare",
    clientSecret: "local-fixture-only",
  }
  await setSsoProvider(fake, "org-2", spare)
  expect(calls).toEqual([
    {
      method: "PUT",
      path: "/organizations/org-2/sso-provider",
      body: {
        issuer: spare.issuer,
        domain: spare.domain,
        oidc: { credentials: "own", clientId: "spare", clientSecret: "local-fixture-only", authorizationEndpoint: spare.authorizationEndpoint, tokenEndpoint: spare.tokenEndpoint, jwksEndpoint: spare.jwksEndpoint },
      },
    },
  ])
})
