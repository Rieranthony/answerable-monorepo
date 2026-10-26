import { expect, test } from "bun:test"
import { adminApi } from "./admin-api"
import { createRegistrar } from "./registrar"
import { fakeIdAdmin } from "./testing"

test("a registrar reads before it writes: what exists is found, what differs is changed with If-Match and widens its lists, and a replayed write is found", async () => {
  const id = fakeIdAdmin()
  const registrar = createRegistrar(adminApi({ id: "https://id.example", token: id.rootSecret, rootLocked: "locked", fetch: id.fetch }))
  const fields = { identifier: "https://mcp.example/acme/mcp", name: "acme", allowedScopes: ["acme:read", "offline_access"], accessTokenTtl: 900 }
  await registrar.resource("acme-resource-v1", fields, true)
  await registrar.resource("acme-resource-v1", fields, true)
  expect(registrar.tally).toEqual({ made: 1, changed: 0, found: 1 })
  // Its own resource follows its manifest, narrowing; another's only widens.
  await registrar.resource("acme-resource-v1", { ...fields, allowedScopes: ["acme:write", "offline_access"] }, true)
  expect(id.state.resources.get(fields.identifier)!.allowedScopes).toEqual(["acme:write", "offline_access"])
  await registrar.resource("acme-resource-v1", { ...fields, allowedScopes: ["acme:read"] })
  expect(id.state.resources.get(fields.identifier)!.allowedScopes).toEqual(["acme:read", "acme:write", "offline_access"])
  const client = { clientId: "claude-code-acme", name: "Claude Code", tokenEndpointAuthMethod: "none" as const, grantTypes: ["authorization_code"], redirectUris: ["http://localhost:47700/callback"], scopes: ["openid"] }
  expect(await registrar.client("claude-code-acme-v1", client)).toMatchObject({ revision: 1, resources: [] })
  const widened = await registrar.client("claude-code-acme-v1", { ...client, scopes: ["acme:read"], redirectUris: ["http://localhost:47701/callback"] })
  expect(widened.revision).toBe(2)
  expect(id.state.clients.get("claude-code-acme")).toMatchObject({ scopes: ["acme:read", "openid"], redirectUris: ["http://localhost:47700/callback", "http://localhost:47701/callback"] })
  await registrar.link("link-v1", "claude-code-acme", fields.identifier, widened)
  await registrar.link("link-v1", "claude-code-acme", fields.identifier, await registrar.client("claude-code-acme-v1", client))
  expect(id.state.links).toEqual(new Set([`claude-code-acme ${fields.identifier}`]))
  expect(await registrar.read("/clients/nobody")).toBeUndefined()
  // A write whose key ID has seen is a replay, and a create ID answers 409 conflict for is found; a conflict otherwise throws, naming the key.
  const groups = `/organizations/${id.platform}/groups`
  await registrar.write("POST", groups, "group-key", { slug: "g", name: "G" })
  const { found } = registrar.tally
  await registrar.write("POST", groups, "group-key", { slug: "g", name: "G" })
  await registrar.write("POST", groups, "another-key", { slug: "g", name: "G" }, { create: true })
  expect(registrar.tally.found).toBe(found + 2)
  await expect(registrar.write("POST", groups, "third-key", { slug: "g", name: "G" })).rejects.toThrow("(Idempotency-Key third-key) answered 409 conflict")
})
