import { afterEach, expect, setSystemTime, test } from "bun:test"
import { createIdAdmin, found, IdError } from "./id"
import { createFakeId } from "./test/fake-id"

afterEach(() => setSystemTime())

test("reads the admin API with a client-credentials token for the admin resource, reused until 30 seconds before it expires", async () => {
  const id = createFakeId({ expiresIn: 300 })
  const admin = createIdAdmin(id.config)
  const start = Date.now()
  setSystemTime(start)
  id.grant("org", "member", [])
  await Promise.all([admin.get("/organizations/org/members/member/access"), admin.get("/organizations/org/members/member/access")])
  setSystemTime(start + 269_000)
  expect(await admin.get("/organizations/org/members/member/access")).toEqual({ effective: true, targets: [] })
  expect(id.requests.filter(request => request.startsWith("POST"))).toHaveLength(1)
  setSystemTime(start + 271_000)
  await admin.get("/organizations/org/members/member/access")
  expect(id.requests.filter(request => request.startsWith("POST"))).toHaveLength(2)
})

test("a refused token is renewed once, and any failure throws an IdError with the status", async () => {
  const id = createFakeId()
  const admin = createIdAdmin(id.config)
  id.grant("org", "member", [])
  await admin.get("/organizations/org/members/member/access")
  id.revoke()
  expect(await admin.get("/organizations/org/members/member/access")).toEqual({ effective: true, targets: [] })
  await expect(admin.get("/organizations/org/members/other/access")).rejects.toMatchObject({ status: 404 })
  id.outage(true)
  await expect(admin.get("/organizations/org/members/member/access")).rejects.toThrow("Answerable ID answered GET /api/admin/v1/organizations/org/members/member/access with 503")
})

test("found makes ID's 404 an answer, undefined, and passes every other result and failure on", async () => {
  const id = createFakeId()
  const admin = createIdAdmin(id.config)
  id.grant("org", "member", [])
  expect(await found(admin.get("/organizations/org/members/member/access"))).toEqual({ effective: true, targets: [] })
  expect(await found(admin.get("/organizations/org/members/other/access"))).toBeUndefined()
  id.outage(true)
  await expect(found(admin.get("/organizations/org/members/member/access"))).rejects.toMatchObject({ status: 503 })
})

test("wrong client credentials name the variables to check", async () => {
  const id = createFakeId()
  const admin = createIdAdmin({ ...id.config, clientSecret: "wrong" })
  await expect(admin.get("/audit-events?limit=1")).rejects.toThrow("Answerable ID refused the Toolbox's client credentials (401); check TOOLBOX_ID_CLIENT_ID, TOOLBOX_ID_CLIENT_SECRET and the client's platform:read capability for the admin resource")
})

const toolbox = "https://toolbox.test/mcp"
const toolboxPath = `/resources/${encodeURIComponent(toolbox)}`

test("manage reads and writes with a token of its own for platform:read and platform:write, a fresh Idempotency-Key per write and If-Match, and returns the body and the ETag", async () => {
  const id = createFakeId()
  const admin = createIdAdmin(id.config)
  id.resource(toolbox, ["toolbox"])
  const read = await admin.manage("GET", toolboxPath)
  expect(read.body).toMatchObject({ allowedScopes: ["toolbox"], clients: [], revision: 1 })
  const patched = await admin.manage("PATCH", toolboxPath, { body: { allowedScopes: ["e2e", "toolbox"] }, ifMatch: read.etag! })
  expect(patched.body).toMatchObject({ allowedScopes: ["e2e", "toolbox"], revision: 2 })
  expect(patched.etag).not.toBe(read.etag)
  await admin.manage("PATCH", toolboxPath, { body: { allowedScopes: ["e2e", "toolbox"] } })
  expect(id.keys).toHaveLength(2)
  expect(new Set(id.keys).size).toBe(2)
  await admin.manage("GET", toolboxPath)
  await admin.get("/audit-events?limit=1")
  expect(id.scopesAsked).toEqual(["platform:read platform:write", "platform:read"])
})

test("a token that was refused is renewed once for manage too", async () => {
  const id = createFakeId()
  const admin = createIdAdmin(id.config)
  id.resource(toolbox, ["toolbox"])
  await admin.manage("GET", toolboxPath)
  id.revoke()
  expect((await admin.manage("GET", toolboxPath)).body).toMatchObject({ revision: 1 })
  expect(id.scopesAsked).toHaveLength(2)
})

test("a failure of manage throws an IdError with the status, ID's problem code and title, and what was called; a body that is not a problem leaves the code out", async () => {
  const id = createFakeId()
  const admin = createIdAdmin(id.config)
  id.resource(toolbox, ["toolbox"])
  const missing = await admin.manage("GET", "/resources/https%3A%2F%2Fnothing.test").catch(error => error)
  expect(missing).toBeInstanceOf(IdError)
  expect(missing).toMatchObject({ status: 404, code: "not_found", message: "Answerable ID answered GET /api/admin/v1/resources/https%3A%2F%2Fnothing.test with 404 not_found: Resource not found" })
  const stale = await admin.manage("PATCH", toolboxPath, { body: { allowedScopes: ["toolbox"] }, ifMatch: '"old:1"' }).catch(error => error)
  expect(stale).toMatchObject({ status: 412, code: "revision_mismatch" })
  id.outage(true)
  const down = await admin.manage("GET", toolboxPath).catch(error => error)
  expect(down).toMatchObject({ status: 503, code: undefined, message: `Answerable ID answered GET /api/admin/v1${toolboxPath} with 503` })
})

test("wrong client credentials name both scopes for manage", async () => {
  const id = createFakeId()
  const admin = createIdAdmin({ ...id.config, clientSecret: "wrong" })
  await expect(admin.manage("GET", toolboxPath)).rejects.toThrow("Answerable ID refused the Toolbox's client credentials (401); check TOOLBOX_ID_CLIENT_ID, TOOLBOX_ID_CLIENT_SECRET and the client's platform:read and platform:write capability for the admin resource")
})

test("a request ID never answers throws an IdError that says what was called and why, for the token and for the call", async () => {
  const id = createFakeId()
  const admin = createIdAdmin(id.config)
  id.unreachable(true)
  await expect(admin.manage("GET", toolboxPath)).rejects.toThrow("Answerable ID did not answer the token request: Unable to connect")
  id.unreachable(false)
  id.resource(toolbox, ["toolbox"])
  await admin.manage("GET", toolboxPath)
  id.unreachable(true)
  const failed = await admin.manage("GET", toolboxPath).catch(error => error)
  expect(failed).toBeInstanceOf(IdError)
  expect(failed).toMatchObject({ status: 0, code: undefined, message: `Answerable ID did not answer GET /api/admin/v1${toolboxPath}: Unable to connect` })
})
