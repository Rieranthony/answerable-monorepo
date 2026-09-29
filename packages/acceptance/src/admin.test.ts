import { afterAll, expect, test } from "bun:test"
import { createAdmin, entitle, type Admin } from "./admin"

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
  await admin("PUT", "/clients/x/resources/y", undefined, { "If-None-Match": "*" })
  const [post, put] = requests
  expect(post!.url).toBe(`${server.url.origin}/api/admin/v1/organizations`)
  expect(post!.headers.get("authorization")).toBe("Bearer root-secret")
  expect(post!.headers.get("content-type")).toBe("application/json")
  expect(put!.headers.get("content-type")).toBeNull()
  expect(put!.headers.get("if-none-match")).toBe("*")
  expect(post!.headers.get("idempotency-key")).not.toBe(put!.headers.get("idempotency-key"))
})

test("a status outside 2xx throws with the method, path, status and body", async () => {
  await expect(admin("DELETE", "/refused")).rejects.toThrow("DELETE /refused returned 403: Not allowed here")
})

test("entitle sends the resource and scopes, and a member or a group only when given", async () => {
  const calls: unknown[][] = []
  const fake: Admin = async (...call) => {
    calls.push(call)
    return {}
  }
  await entitle(fake, "org-1", { resource: "https://toolbox.test/mcp", scopes: ["toolbox/docs:read"] })
  await entitle(fake, "org-1", { resource: "https://toolbox.test/mcp", scopes: ["toolbox/docs:read"], memberId: "member-1" })
  await entitle(fake, "org-1", { resource: "https://toolbox.test/mcp", scopes: ["toolbox/docs:read"], groupId: "group-1" })
  expect(calls.map(([method, path, body]) => [method, path, JSON.parse(JSON.stringify(body))])).toEqual([
    ["POST", "/organizations/org-1/entitlements", { resource: "https://toolbox.test/mcp", scopes: ["toolbox/docs:read"] }],
    ["POST", "/organizations/org-1/entitlements", { resource: "https://toolbox.test/mcp", scopes: ["toolbox/docs:read"], memberId: "member-1" }],
    ["POST", "/organizations/org-1/entitlements", { resource: "https://toolbox.test/mcp", scopes: ["toolbox/docs:read"], groupId: "group-1" }],
  ])
})
