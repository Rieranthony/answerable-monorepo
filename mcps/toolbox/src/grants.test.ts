import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test"
import { createIdAdmin } from "@answerable/id-admin"
import { createFakeId } from "@answerable/id-admin/testing"
import { defineProvider, defineTool, ToolError } from "@answerable/mcp"
import { testPrincipal as principal } from "@answerable/mcp/testing"
import { z } from "zod"
import { allowedScopes, createGrantsReader, isGrant } from "./grants"

const toolbox = "https://toolbox.test/mcp"
afterEach(() => setSystemTime())

function setup() {
  const id = createFakeId()
  const grants = createGrantsReader({ id: createIdAdmin(id.config), resource: toolbox })
  const caller = principal()
  const reads = () => id.requests.filter(request => request.endsWith("/access")).length
  return { id, grants, caller, reads }
}

test("grant strings are providers, domains and capabilities, and toolbox/approve and toolbox/code", () => {
  for (const scope of ["e2e", "e2e/records", "e2e/records.list", "toolbox/approve", "toolbox/code", "a23456789012/b234567890123456.c234567890123456"]) expect(isGrant(scope), scope).toBe(true)
  for (const scope of ["toolbox", "offline_access", "e2e:read", "E2E", "e2e/records.list.more", "a234567890123/b", "e2e/", "e2e/records."]) expect(isGrant(scope), scope).toBe(false)
})

test("the Toolbox resource allows toolbox, offline_access, toolbox/approve and every grant string of its providers", () => {
  const tool = (name: string) => defineTool({ name, description: "A fixture tool that returns nothing and changes nothing.", input: z.object({}), output: z.object({}), async execute() { return {} } })
  const providers = [defineProvider({ id: "crm", version: "2026-09-29", tools: [tool("contacts.list"), tool("contacts.get"), tool("deals.list")] })]
  expect(allowedScopes(providers)).toEqual([
    "crm", "crm/contacts", "crm/contacts.get", "crm/contacts.list", "crm/deals", "crm/deals.list", "offline_access", "toolbox", "toolbox/approve",
  ])
})

test("reads the grant strings of the member's Toolbox targets: the resource's through every client, a client's own only through that client, and nothing else", async () => {
  const { id, grants, caller, reads } = setup()
  id.grant(caller.organizationId, caller.membershipId, [
    { kind: "resource", id: toolbox, scopes: ["e2e/records", "toolbox", "offline_access"] },
    { kind: "client_resource", id: "claude-code", resource: toolbox, scopes: ["toolbox", "crm", "e2e/records"] },
    { kind: "client_resource", id: "claude-code", resource: "https://other.test/mcp", scopes: ["other"] },
    { kind: "resource", id: "https://other.test/mcp", scopes: ["other/secrets"] },
    { kind: "client", id: "claude-code", scopes: ["openid", "offline_access"] },
  ])
  expect(await grants.read({ ...caller, clientId: "claude-code" })).toEqual(["crm", "e2e/records"])
  // The same cached read, through another host client: the grant limited to claude-code gives nothing here.
  expect(await grants.read({ ...caller, clientId: "chatgpt" })).toEqual(["e2e/records"])
  expect(reads()).toBe(1)
})

test("a member ID does not know has no grants", async () => {
  const { grants, caller } = setup()
  expect(await grants.read(caller)).toEqual([])
})

test("a read within 60 seconds is served from the cache, and concurrent reads share one call", async () => {
  const { id, grants, caller, reads } = setup()
  id.grant(caller.organizationId, caller.membershipId, [{ kind: "resource", id: toolbox, scopes: ["e2e"] }])
  const start = Date.now()
  setSystemTime(start)
  await Promise.all([grants.read(caller), grants.read(caller), grants.read({ ...caller })])
  expect(reads()).toBe(1)
  setSystemTime(start + 59_000)
  await grants.read(caller)
  expect(reads()).toBe(1)
  setSystemTime(start + 60_000)
  id.grant(caller.organizationId, caller.membershipId, [{ kind: "resource", id: toolbox, scopes: ["crm"] }])
  expect(await grants.read(caller)).toEqual(["crm"])
  expect(reads()).toBe(2)
})

test("a token with another organisation authorisation version reads again", async () => {
  const { id, grants, caller, reads } = setup()
  id.grant(caller.organizationId, caller.membershipId, [{ kind: "resource", id: toolbox, scopes: ["e2e"] }])
  await grants.read(caller)
  id.grant(caller.organizationId, caller.membershipId, [])
  expect(await grants.read({ ...caller, organizationAuthorizationVersion: 2 })).toEqual([])
  expect(reads()).toBe(2)
})

test("invalidating an organisation reads its members again, and invalidating a user reads them again in every organisation; other entries are kept", async () => {
  const { id, grants, caller, reads } = setup()
  const other = principal()
  // The caller's person, a member of a second organisation too.
  const elsewhere = principal({ userId: caller.userId })
  for (const person of [caller, other, elsewhere]) id.grant(person.organizationId, person.membershipId, [{ kind: "resource", id: toolbox, scopes: ["e2e"] }])
  for (const person of [caller, other, elsewhere]) await grants.read(person)
  grants.invalidate([caller.organizationId, crypto.randomUUID()])
  id.grant(caller.organizationId, caller.membershipId, [])
  id.grant(elsewhere.organizationId, elsewhere.membershipId, [])
  expect([await grants.read(caller), await grants.read(other), await grants.read(elsewhere)]).toEqual([[], ["e2e"], ["e2e"]])
  expect(reads()).toBe(4)
  grants.invalidate([], [caller.userId, crypto.randomUUID()])
  expect([await grants.read(other), await grants.read(elsewhere)]).toEqual([["e2e"], []])
  expect(reads()).toBe(5)
})

test("an invalidation that names an organisation or a user calls changed once, whether or not any of its members is cached; naming none does not", () => {
  const id = createFakeId()
  let changes = 0
  const grants = createGrantsReader({ id: createIdAdmin(id.config), resource: toolbox, changed: () => { changes++ } })
  grants.invalidate([], [])
  expect(changes).toBe(0)
  grants.invalidate(new Set([crypto.randomUUID(), crypto.randomUUID()]))
  expect(changes).toBe(1)
  grants.invalidate([], [crypto.randomUUID()])
  expect(changes).toBe(2)
})

test("when ID fails, a cached entry answers until its 60 seconds end, and without one the read answers UPSTREAM_UNAVAILABLE", async () => {
  const { id, grants, caller } = setup()
  const log = spyOn(console, "error").mockImplementation(() => {})
  try {
    id.grant(caller.organizationId, caller.membershipId, [{ kind: "resource", id: toolbox, scopes: ["e2e"] }])
    const start = Date.now()
    setSystemTime(start)
    await grants.read(caller)
    grants.invalidate([caller.organizationId])
    id.outage(true)
    setSystemTime(start + 59_000)
    expect(await grants.read(caller)).toEqual(["e2e"])
    setSystemTime(start + 60_000)
    const refusal = await grants.read(caller).catch(error => error)
    expect(refusal).toBeInstanceOf(ToolError)
    expect(refusal).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", message: "Answerable ID did not answer with your access; try again shortly", retry: { policy: "after_delay", after_ms: 1000 } })
    expect(log.mock.calls.map(call => call[0])).toEqual(["[toolbox] reading access failed", "[toolbox] reading access failed"])
    id.outage(false)
    expect(await grants.read(caller)).toEqual(["e2e"])
  } finally { log.mockRestore() }
})
