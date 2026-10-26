import { expect, test } from "bun:test"
import { createFakeId } from "@answerable/id-admin/testing"
import { adminCall, all, createRegistrar, machineToken } from "./local-id"

const issuer = "http://localhost:47300"

test("every item of a list is read, following the cursor page after page", async () => {
  const id = createFakeId({ issuer, rootSecret: "root", pageSize: 2 })
  for (let index = 0; index < 5; index++) id.group(id.organizationId, { slug: `group-${index}` })
  const groups = await all<{ slug: string }>(adminCall(id.config.fetch, "root"), `/organizations/${id.organizationId}/groups`)
  expect(groups.map(group => group.slug).sort()).toEqual(["group-0", "group-1", "group-2", "group-3", "group-4"])
  expect(id.requests.filter(request => request.includes("/groups"))).toHaveLength(3)
})

test("a list ID refuses is a failure naming the call", async () => {
  const id = createFakeId({ issuer, rootSecret: "root" })
  await expect(all(adminCall(id.config.fetch, "root"), `/organizations/${crypto.randomUUID()}/groups`)).rejects.toThrow(/GET \/organizations\/.*\/groups answered 404/)
})

test("a machine token is the token ID issues, or undefined when ID refuses the client; it throws when ID does not answer", async () => {
  const id = createFakeId({ issuer, clientId: "hub", clientSecret: "secret" })
  const ask = (secret: string, resource = `${issuer}/api/admin`) => machineToken(id.config.fetch, { clientId: "hub", clientSecret: secret }, resource, "platform:read")
  expect(await ask("secret")).toStartWith("machine-")
  expect(await ask("wrong")).toBeUndefined()
  expect(await ask("secret", "http://elsewhere.test")).toBeUndefined()
  id.unreachable(true)
  await expect(ask("secret")).rejects.toThrow("Unable to connect")
})

test("a registrar reads before it writes: what exists is found, what differs is changed with If-Match and widens its lists, and a replayed write is found", async () => {
  const id = createFakeId({ issuer, rootSecret: "root" })
  const registrar = createRegistrar(adminCall(id.config.fetch, "root"))
  const fields = { identifier: "http://localhost:47510/acme/mcp", name: "acme", allowedScopes: ["acme:read", "offline_access"], accessTokenTtl: 900 }
  await registrar.resource("acme-resource-v1", fields, true)
  await registrar.resource("acme-resource-v1", fields, true)
  expect(registrar.tally).toEqual({ made: 1, changed: 0, found: 1 })
  // Its own resource follows its manifest, narrowing; another's only widens.
  await registrar.resource("acme-resource-v1", { ...fields, allowedScopes: ["acme:write", "offline_access"] }, true)
  expect(id.resourceOf(fields.identifier).allowedScopes).toEqual(["acme:write", "offline_access"])
  await registrar.resource("acme-resource-v1", { ...fields, allowedScopes: ["acme:read"] })
  expect(id.resourceOf(fields.identifier).allowedScopes).toEqual(["acme:read", "acme:write", "offline_access"])
  const client = { clientId: "claude-code-acme", name: "Claude Code", tokenEndpointAuthMethod: "none" as const, grantTypes: ["authorization_code"], redirectUris: ["http://localhost:47700/callback"], scopes: ["openid"] }
  const held = await registrar.client("claude-code-acme-v1", client)
  expect(held).toMatchObject({ revision: 1, resources: [] })
  const widened = await registrar.client("claude-code-acme-v1", { ...client, scopes: ["acme:read"], redirectUris: ["http://localhost:47701/callback"] })
  expect(widened.revision).toBe(2)
  expect(await registrar.read("/clients/claude-code-acme")).toMatchObject({ body: { scopes: ["acme:read", "openid"], redirectUris: expect.arrayContaining(["http://localhost:47700/callback", "http://localhost:47701/callback"]) } })
  await registrar.link("link-v1", "claude-code-acme", fields.identifier, widened)
  const linked = await registrar.client("claude-code-acme-v1", client)
  await registrar.link("link-v1", "claude-code-acme", fields.identifier, linked)
  expect(id.resourceOf(fields.identifier).clients).toEqual(["claude-code-acme"])
  expect(await registrar.read("/clients/nobody")).toBeUndefined()
  await expect(registrar.read("/resources/%")).rejects.toThrow()
  // A write whose key ID has seen is a replay, and a create ID answers 409 conflict for is found.
  await registrar.write("POST", `/organizations/${id.organizationId}/groups`, "group-key", { slug: "g", name: "G" })
  const count = registrar.tally.found
  await registrar.write("POST", `/organizations/${id.organizationId}/groups`, "group-key", { slug: "g", name: "G" })
  await registrar.write("POST", `/organizations/${id.organizationId}/groups`, "another-key", { slug: "g", name: "G" }, { create: true })
  expect(registrar.tally.found).toBe(count + 2)
  await expect(registrar.write("POST", `/organizations/${id.organizationId}/groups`, "third-key", { slug: "g", name: "G" })).rejects.toThrow("answered 409 conflict")
  expect(registrar.counts()).toMatch(/^\d+ made, \d+ changed, \d+ found$/)
})
