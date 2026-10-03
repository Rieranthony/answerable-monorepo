import { expect, spyOn, test } from "bun:test"
import { createIdAdmin } from "@answerable/id-admin"
import { createFakeId } from "@answerable/id-admin/testing"
import { createFakeToolbox, createIdFake, toolboxResource } from "./test/admin"
import { createToolboxAdmin } from "./toolbox"

const failure = (promise: Promise<unknown>) => promise.then(() => { throw new Error("expected a refusal") }, (error: unknown) => error)

test("a refusal by ID or the Toolbox is UPSTREAM_REJECTED with what was refused, and no answer from either UPSTREAM_UNAVAILABLE", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {})
  try {
    // A machine client ID never linked to the Toolbox's admin resource.
    const unlinked = createFakeId({ clientId: "admin-mcp" })
    const refusedToken = createToolboxAdmin({ id: createIdAdmin(unlinked.config), resource: toolboxResource, fetch: createFakeToolbox(createIdFake()).fetch })
    expect(await failure(refusedToken.providers())).toMatchObject({
      code: "UPSTREAM_REJECTED", details: { upstream: { status: 400, code: null } },
      message: `Answerable ID refused the client credentials of admin-mcp (400); check the client id, the client secret and the client's toolbox:admin capability for ${toolboxResource}`,
    })
    const id = createIdFake()
    const forbidden = createToolboxAdmin({
      id: createIdAdmin(id.config), resource: toolboxResource,
      fetch: async () => Response.json({ error: { code: "forbidden", message: "The token lacks the toolbox:admin scope" } }, { status: 403 }),
    })
    expect(await failure(forbidden.enabled(crypto.randomUUID()))).toMatchObject({ code: "UPSTREAM_REJECTED", details: { upstream: { status: 403, code: "forbidden" } } })
    const gone = createToolboxAdmin({ id: createIdAdmin(id.config), resource: toolboxResource, fetch: async () => { throw new TypeError("Unable to connect") } })
    expect(await failure(gone.providers())).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", message: `The Toolbox at ${toolboxResource} did not answer; try again shortly` })
    id.unreachable(true)
    const silent = createToolboxAdmin({ id: createIdAdmin(id.config), resource: toolboxResource, fetch: createFakeToolbox(id).fetch })
    expect(await failure(silent.providers())).toMatchObject({ code: "UPSTREAM_UNAVAILABLE" })
    const broken = createToolboxAdmin({ id: createIdAdmin(createIdFake().config), resource: toolboxResource, fetch: async () => new Response("Bad gateway", { status: 502 }) })
    expect(await failure(broken.enable(crypto.randomUUID(), { hostClientIds: ["a"], providers: ["e2e"] }))).toMatchObject({
      code: "UPSTREAM_UNAVAILABLE", message: expect.stringMatching(/^The Toolbox answered POST .+\/enable with 502$/), details: { upstream: { status: 502, code: null } },
    })
  } finally { log.mockRestore() }
})
