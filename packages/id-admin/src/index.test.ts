import { afterEach, expect, setSystemTime, test } from "bun:test"
import { createIdAdmin, found, IdError } from "./index"
import { createFakeId } from "./testing"

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

test("wrong client credentials name the client and what to check", async () => {
  const id = createFakeId()
  const admin = createIdAdmin({ ...id.config, clientSecret: "wrong" })
  await expect(admin.get("/audit-events?limit=1")).rejects.toThrow("Answerable ID refused the client credentials of toolbox-hub (401); check the client id, the client secret and the client's platform:read capability for the admin resource")
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
  const keys = id.received.map(request => request.idempotencyKey).filter(key => key !== null)
  expect(keys).toHaveLength(2)
  expect(new Set(keys).size).toBe(2)
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
  await expect(admin.manage("GET", toolboxPath)).rejects.toThrow("Answerable ID refused the client credentials of toolbox-hub (401); check the client id, the client secret and the client's platform:read and platform:write capability for the admin resource")
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

test("a request id is sent as x-request-id on a read and on a write, and left out when none is given", async () => {
  const id = createFakeId()
  const admin = createIdAdmin(id.config)
  id.resource(toolbox, ["toolbox"])
  await admin.get("/audit-events?limit=1", { requestId: "exec-1" })
  await admin.manage("PATCH", toolboxPath, { body: { allowedScopes: ["toolbox"] }, requestId: "exec-2" })
  await admin.manage("GET", toolboxPath, { requestId: "exec-3" })
  await admin.get("/audit-events?limit=1")
  expect(id.received.map(request => request.requestId)).toEqual(["exec-1", "exec-2", "exec-3", null])
})

test("a caller-chosen idempotency key is sent on a write instead of a random one, never on a read, and a random one is sent when none is given", async () => {
  const id = createFakeId()
  const admin = createIdAdmin(id.config)
  id.resource(toolbox, ["toolbox"])
  await admin.manage("PATCH", toolboxPath, { body: { allowedScopes: ["toolbox"] }, idempotencyKey: "intent-1" })
  await admin.manage("PATCH", toolboxPath, { body: { allowedScopes: ["toolbox"] } })
  await admin.manage("GET", toolboxPath, { idempotencyKey: "ignored" })
  const [chosen, random, read] = id.received
  expect(chosen!.idempotencyKey).toBe("intent-1")
  expect(random!.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/)
  expect(read!.idempotencyKey).toBeNull()
})

test("the request id and the idempotency key, chosen or random, stay the same when the call is resent after a 401", async () => {
  const id = createFakeId()
  const admin = createIdAdmin(id.config)
  id.resource(toolbox, ["toolbox"])
  await admin.manage("GET", toolboxPath)
  for (const idempotencyKey of ["intent-2", undefined]) {
    id.received.length = 0
    id.revoke()
    await admin.manage("PATCH", toolboxPath, { body: { allowedScopes: ["toolbox"] }, requestId: "exec-4", idempotencyKey })
    expect(id.received).toHaveLength(2)
    expect(id.received[1]).toEqual(id.received[0]!)
    expect(id.received[0]).toMatchObject({ requestId: "exec-4", idempotencyKey: idempotencyKey ?? expect.stringMatching(/^[0-9a-f-]{36}$/) })
  }
})

test("manage returns the Operation-Id ID sends with a write, and null where it sends none", async () => {
  const id = createFakeId()
  const admin = createIdAdmin(id.config)
  id.resource(toolbox, ["toolbox"])
  const read = await admin.manage("GET", toolboxPath)
  const first = await admin.manage("PATCH", toolboxPath, { body: { allowedScopes: ["toolbox"] } })
  const second = await admin.manage("PATCH", toolboxPath, { body: { allowedScopes: ["toolbox"] } })
  expect(read.operationId).toBeNull()
  expect(first.operationId).toMatch(/^[0-9a-f-]{36}$/)
  expect(second.operationId).not.toBe(first.operationId)
})
