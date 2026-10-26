// bun mcp dev registers an MCP in the local ID the way the deploy's register Job does (infra/ops/src/register.ts): the same resource, client and link,
// field for field. Each registers over what the other made, on the Job's own fake of ID, and neither finds anything to change.
import { expect, test } from "bun:test"
import { register } from "../../infra/ops/src/register"
import { fakeIdAdmin, memoryStore } from "../../infra/ops/src/testing"
import { adminCall, createRegistrar, registerStandalone, registerToolbox } from "./local-id"

type Id = ReturnType<typeof fakeIdAdmin>
const acme = ["acme:read", "acme:write"]
const options = { id: "http://localhost:47300", toolbox: "http://localhost:47400", adminMcp: "http://localhost:47520", mcpOrigin: "http://localhost:47510", platformSlug: "answerable", callbackPort: 47700 }
const job = (id: Id) => register({ ...options, token: id.rootSecret, mcps: [{ name: "acme", serve: "standalone", scopes: acme }], store: memoryStore().store, fetch: id.fetch, log: () => {} })
const cli = async (id: Id) => {
  const registrar = createRegistrar(adminCall(id.fetch, id.rootSecret))
  await registerToolbox(registrar)
  await registerStandalone(registrar, { name: "acme", scopes: acme })
  return registrar.tally
}
// The calls from `from` on that change something, or only the PATCHes.
const writes = (id: Id, from: number, method?: string) => id.state.calls.slice(from).filter(call => (method ? call.method === method : call.method !== "GET"))

test("what the register Job made is found, not changed, by bun mcp dev's registration", async () => {
  const id = fakeIdAdmin()
  await job(id)
  const from = id.state.calls.length
  expect(await cli(id)).toEqual({ made: 0, changed: 0, found: 6 })
  expect(writes(id, from)).toEqual([])
})

test("what bun mcp dev's registration made is found, not changed, by the register Job, which only adds the rest of the deployment", async () => {
  const id = fakeIdAdmin()
  expect(await cli(id)).toEqual({ made: 6, changed: 0, found: 0 })
  const from = id.state.calls.length
  await job(id)
  // The Job changes none of the rows bun mcp dev made: no PATCH of the Toolbox's or acme's resources and clients.
  expect(writes(id, from, "PATCH")).toEqual([])
})
