import { afterEach, expect, setSystemTime, test } from "bun:test"
import { createIdAdmin } from "./id"
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

test("a refused token is renewed once, 404 is undefined and any other failure throws with the status", async () => {
  const id = createFakeId()
  const admin = createIdAdmin(id.config)
  id.grant("org", "member", [])
  await admin.get("/organizations/org/members/member/access")
  id.revoke()
  expect(await admin.get("/organizations/org/members/member/access")).toEqual({ effective: true, targets: [] })
  expect(await admin.get("/organizations/org/members/other/access")).toBeUndefined()
  id.outage(true)
  await expect(admin.get("/organizations/org/members/member/access")).rejects.toThrow("Answerable ID answered GET /api/admin/v1/organizations/org/members/member/access with 503")
})

test("wrong client credentials name the variables to check", async () => {
  const id = createFakeId()
  const admin = createIdAdmin({ ...id.config, clientSecret: "wrong" })
  await expect(admin.get("/audit-events?limit=1")).rejects.toThrow("Answerable ID refused the Toolbox's client credentials (401); check TOOLBOX_ID_CLIENT_ID, TOOLBOX_ID_CLIENT_SECRET and the client's platform:read capability for the admin resource")
})
