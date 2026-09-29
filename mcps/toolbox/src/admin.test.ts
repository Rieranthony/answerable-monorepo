import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"
import { SQL } from "bun"
import { toolboxAdminResource } from "./admin"
import { ingest } from "./catalogue"
import { migrate } from "./db/migrate"
import { createEvidence } from "./evidence"
import { testDatabase, testDatabaseUrl } from "./test/database"
import { adminResource, createHub, providerId, records, resource } from "./test/hub"

const db = testDatabase()
beforeAll(() => migrate(db))
afterAll(() => db.close())

test("the admin resource is the Toolbox's origin and /admin", () => {
  expect(toolboxAdminResource(resource)).toBe(adminResource)
  expect(toolboxAdminResource("http://localhost:47400/mcp")).toBe("http://localhost:47400/admin")
  expect(toolboxAdminResource("https://toolbox.answerable.org/some/path/mcp")).toBe("https://toolbox.answerable.org/admin")
})

test("every route needs a machine client's token for the admin resource with toolbox:admin: none, garbage, another audience, a person's token and a missing scope are refused", async () => {
  const { admin: call, token, mcp } = await createHub(db, [records(providerId())])
  const challenge = 'Bearer realm="toolbox-admin"'
  const refused = [
    await call("GET", "/providers", { authorization: null }),
    await call("GET", "/providers", { authorization: "Bearer nonsense" }),
    await call("GET", "/providers", { authorization: "Basic YTpi" }),
    await call("GET", "/providers", { authorization: `Bearer ${await token(resource)}` }),
    await call("GET", "/providers", { authorization: `Bearer ${await mcp.issuer.sign({ resource: adminResource, scopes: ["toolbox:admin"] })}` }),
  ]
  for (const answer of refused) {
    expect(answer.status).toBe(401)
    expect(answer.body).toEqual({ error: { code: "unauthorized", message: `Send a machine client's access token for ${adminResource} as Authorization: Bearer` } })
    expect(answer.headers.get("WWW-Authenticate")).toBe(challenge)
  }
  const scoped = await call("GET", "/providers", { authorization: `Bearer ${await token(adminResource, ["toolbox", "offline_access"])}` })
  expect(scoped.status).toBe(403)
  expect(scoped.body).toEqual({ error: { code: "forbidden", message: "The token lacks the toolbox:admin scope; ask Answerable ID for a token with scope=toolbox:admin" } })
  expect(scoped.headers.get("WWW-Authenticate")).toBe('Bearer error="insufficient_scope", scope="toolbox:admin"')
  const ok = await call("GET", "/providers")
  expect(ok.status).toBe(200)
  for (const answer of [ok, scoped, ...refused]) expect(answer.headers.get("Cache-Control")).toBe("no-store")
})

test("an unknown route, a wrong method and a base path answer 404 with the route asked; a body that is not JSON, or has the wrong shape, answers 400", async () => {
  const { admin: call } = await createHub(db, [records(providerId())])
  expect(await call("GET", "/nothing")).toMatchObject({ status: 404, body: { error: { code: "not_found", message: "There is no route GET /admin/v1/nothing" } } })
  expect(await call("DELETE", "/providers")).toMatchObject({ status: 404, body: { error: { code: "not_found" } } })
  expect((await call("GET", "")).status).toBe(404)
  expect(await call("DELETE", "/host-clients/%E0")).toMatchObject({ status: 400, body: { error: { code: "invalid_request", message: "%E0 is not valid percent-encoding" } } })
  expect(await call("PUT", "/host-clients/host", { body: "{ nope" })).toMatchObject({ status: 400, body: { error: { code: "invalid_request", message: "The body must be JSON" } } })
  const invalid = await call("PUT", "/host-clients/host", { body: { projection: "everything", direct_limit: 0, extra: true } })
  expect(invalid.status).toBe(400)
  expect(invalid.body.error.code).toBe("invalid_request")
  for (const field of ["projection", "direct_limit", "extra"]) expect(invalid.body.error.message).toContain(field)
})

test("GET /providers lists each mounted provider's capabilities with kind, risk and title, and not the Toolbox's own provider", async () => {
  const [b, a] = [`b${providerId().slice(1)}`, `a${providerId().slice(1)}`]
  const { admin: call } = await createHub(db, [records(b), records(a, { version: "2026-10-01", extra: ["notes.list"] })])
  expect((await call("GET", "/providers")).body).toEqual({ items: [
    { id: a, version: "2026-10-01", capabilities: [
      { identity: `${a}/notes.list`, version: "2026-10-01", kind: "read", risk: null, title: null },
      { identity: `${a}/records.create`, version: "2026-10-01", kind: "mutate", risk: "low", title: null },
      { identity: `${a}/records.list`, version: "2026-10-01", kind: "read", risk: null, title: "List records" },
    ] },
    { id: b, version: "2026-09-29", capabilities: [
      { identity: `${b}/records.create`, version: "2026-09-29", kind: "mutate", risk: "low", title: null },
      { identity: `${b}/records.list`, version: "2026-09-29", kind: "read", risk: null, title: "List records" },
    ] },
  ] })
})

test("PUT catalogue stores the entry as given, again and again, replacing the last; GET lists the organisation's entries by provider", async () => {
  const [a, b] = [`a${providerId().slice(1)}`, `b${providerId().slice(1)}`]
  const { admin: call } = await createHub(db, [records(a), records(b)])
  const organisation = crypto.randomUUID()
  const at = (provider: string) => `/organisations/${organisation}/catalogue/${provider}`
  expect(await call("GET", `/organisations/${organisation}/catalogue`)).toMatchObject({ status: 200, body: { items: [] } })
  const overrides = { disabled: [`${a}/records.list`], policy_class: { [`${a}/records.create`]: "human" } }
  const put = await call("PUT", at(a), { body: { enabled: true, overrides } })
  expect(put).toMatchObject({ status: 200, body: { provider_id: a, enabled: true, overrides } })
  expect((await call("PUT", at(a), { body: { enabled: true, overrides } })).body).toEqual(put.body)
  await call("PUT", at(b), { body: { enabled: false } })
  expect((await call("GET", `/organisations/${organisation}/catalogue`)).body).toEqual({ items: [
    { provider_id: a, enabled: true, overrides },
    { provider_id: b, enabled: false, overrides: { disabled: [], policy_class: {} } },
  ] })
  expect((await call("PUT", at(a), { body: { enabled: true } })).body.overrides).toEqual({ disabled: [], policy_class: {} })
})

test("PUT catalogue refuses a provider that is not mounted, identities it does not know, a class for a read and a malformed body, and stores nothing", async () => {
  const [a, b] = [`a${providerId().slice(1)}`, `b${providerId().slice(1)}`]
  const { admin: call } = await createHub(db, [records(a), records(b)])
  const organisation = crypto.randomUUID()
  const put = (provider: string, body: unknown, id: string = organisation) => call("PUT", `/organisations/${id}/catalogue/${provider}`, { body })
  expect(await put("nothing", { enabled: true })).toMatchObject({ status: 404, body: { error: { code: "provider_not_found", message: expect.stringContaining("nothing") } } })
  expect(await put("toolbox", { enabled: true })).toMatchObject({ status: 404, body: { error: { code: "provider_not_found" } } })
  const unknown = await put(a, { enabled: true, overrides: { disabled: [`${a}/records.list`, `${a}/records.nothing`, `${b}/records.list`], policy_class: { [`${a}/records.gone`]: "agent" } } })
  expect(unknown).toMatchObject({ status: 422, body: { error: { code: "unknown_capability" } } })
  expect(unknown.body.error.message).toBe(`${a} has no capability ${a}/records.nothing, ${b}/records.list, ${a}/records.gone; GET /admin/v1/providers lists them`)
  expect(await put(a, { enabled: true, overrides: { policy_class: { [`${a}/records.list`]: "human" } } })).toMatchObject({
    status: 422, body: { error: { code: "not_a_mutation", message: `${a}/records.list is a read; a policy class applies to mutations` } },
  })
  for (const body of [{}, { enabled: "yes" }, { enabled: true, overrides: { policy_class: { [`${a}/records.create`]: "nobody" } } }, { enabled: true, overrides: { disabled: "all" } }, { enabled: true, extra: 1 }]) {
    expect(await put(a, body), JSON.stringify(body)).toMatchObject({ status: 400, body: { error: { code: "invalid_request" } } })
  }
  expect(await put(a, { enabled: true }, "not-a-uuid")).toMatchObject({ status: 400, body: { error: { code: "invalid_request", message: "The organisation id not-a-uuid is not a UUID" } } })
  expect((await call("GET", `/organisations/${organisation}/catalogue`)).body).toEqual({ items: [] })
})

test("capabilities a new version adds stay disabled until PUT catalogue lists them as enabled", async () => {
  const provider = providerId()
  const { admin: call } = await createHub(db, [records(provider)])
  const organisation = crypto.randomUUID()
  await call("PUT", `/organisations/${organisation}/catalogue/${provider}`, { body: { enabled: true } })
  await ingest(db, [records(provider, { version: "2026-10-01", extra: ["notes.list"] })])
  const entry = async () => (await call("GET", `/organisations/${organisation}/catalogue`)).body.items[0].overrides.disabled
  expect(await entry()).toEqual([`${provider}/notes.list`])
  await call("PUT", `/organisations/${organisation}/catalogue/${provider}`, { body: { enabled: true, overrides: { disabled: [] } } })
  expect(await entry()).toEqual([])
})

test("host clients are stored by client id with the defaults auto and 40, replaced by PUT, removed by DELETE and listed by id", async () => {
  const { admin: call } = await createHub(db, [records(providerId())])
  const client = `host-${crypto.randomUUID().slice(0, 8)}`
  const list = async () => (await call("GET", "/host-clients")).body.items.filter((row: { client_id: string }) => row.client_id.startsWith("host-") || row.client_id.startsWith("https://"))
  expect(await call("PUT", `/host-clients/${client}`, { body: {} })).toMatchObject({ status: 200, body: { client_id: client, projection: "auto", direct_limit: 40 } })
  expect((await call("PUT", `/host-clients/${client}`, { body: { projection: "meta", direct_limit: 128 } })).body).toEqual({ client_id: client, projection: "meta", direct_limit: 128 })
  const url = "https://claude.ai/oauth/metadata.json"
  await call("PUT", `/host-clients/${encodeURIComponent(url)}`, { body: { projection: "direct" } })
  expect((await list()).map((row: { client_id: string }) => row.client_id)).toEqual([client, url].toSorted())
  expect(await call("DELETE", `/host-clients/${client}`)).toMatchObject({ status: 204, body: undefined })
  expect(await call("DELETE", `/host-clients/${client}`)).toMatchObject({ status: 404, body: { error: { code: "host_client_not_found", message: `There is no host client ${client}; GET /admin/v1/host-clients lists them` } } })
  expect((await list()).map((row: { client_id: string }) => row.client_id)).toEqual([url])
  await call("DELETE", `/host-clients/${encodeURIComponent(url)}`)
  for (const body of [{ direct_limit: 0 }, { direct_limit: 129 }, { direct_limit: 1.5 }, { projection: "both" }]) {
    expect(await call("PUT", `/host-clients/${client}`, { body }), JSON.stringify(body)).toMatchObject({ status: 400, body: { error: { code: "invalid_request" } } })
  }
})

test("GET evidence/verify runs the organisation's chain check", async () => {
  const { admin: call } = await createHub(db, [records(providerId())])
  const organisation = crypto.randomUUID()
  expect(await call("GET", `/organisations/${organisation}/evidence/verify`)).toMatchObject({ status: 200, body: { ok: true, length: 0 } })
  for (const outcome of ["success", "failure"] as const) {
    await createEvidence(db).record({ organisation_id: organisation, kind: "capability.completed", actor_type: "user", actor_id: "someone", outcome })
  }
  expect((await call("GET", `/organisations/${organisation}/evidence/verify`)).body).toEqual({ ok: true, length: 2 })
})

test("a failure the admin API did not expect answers 500 without its cause, and is logged", async () => {
  const own = new SQL({ url: testDatabaseUrl, max: 1 })
  const { admin: call } = await createHub(own, [records(providerId())])
  await own.close()
  const log = spyOn(console, "error").mockImplementation(() => {})
  try {
    expect(await call("GET", "/host-clients")).toMatchObject({ status: 500, body: { error: { code: "internal_error", message: "The Toolbox failed to answer; its log says why" } } })
    expect(log).toHaveBeenCalledWith("[toolbox] admin API failed", expect.anything())
  } finally { log.mockRestore() }
})
