import { afterAll, expect, test } from "bun:test"
import { createAdmin, registerResource, type Admin } from "./admin"

const requests: Request[] = []
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    requests.push(request.clone())
    const { pathname } = new URL(request.url)
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
