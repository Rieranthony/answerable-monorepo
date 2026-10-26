import { expect, test } from "bun:test"
import { createFakeId } from "@answerable/id-admin/testing"
import { adminCall, all, machineToken } from "./local-id"

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
