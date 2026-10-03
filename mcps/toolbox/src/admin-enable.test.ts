import { afterAll, beforeAll, expect, test } from "bun:test"
import { readCatalogue, writeCatalogue } from "./catalogue"
import { migrate } from "./db/migrate"
import { allowedScopes } from "./grants"
import { database } from "./test/database"
import { createHub, providerId, records, resource } from "./test/hub"

const db = database.connect()
beforeAll(() => migrate(db))
afterAll(() => db.close())

const path = encodeURIComponent(resource)
const api = "/api/admin/v1"

// A hub over a fake ID that knows the Toolbox resource, some host clients and one organisation.
async function setup({ providers = 1, hosts = ["host-a"], scopes = ["offline_access", "toolbox"], pageSize }: { providers?: number; hosts?: string[]; scopes?: string[]; pageSize?: number } = {}) {
  const mounted = Array.from({ length: providers }, () => records(providerId()))
  const hub = await createHub(db, mounted, { pageSize })
  const organisation = crypto.randomUUID()
  hub.id.resource(resource, scopes)
  for (const host of hosts) hub.id.client(host)
  hub.id.organisation(organisation)
  const enable = (body: unknown) => hub.admin("POST", `/organisations/${organisation}/enable`, { body })
  // Every call to ID's admin API so far, in order, without the token requests.
  const calls = () => hub.id.requests.filter(request => !request.includes("/auth/oauth2/token")).map(request => request.replace(api, ""))
  return { ...hub, mounted, organisation, enable, calls }
}
const rows = (hub: Awaited<ReturnType<typeof setup>>) => ({
  capabilities: hub.id.capabilities(hub.organisation).map(({ clientId, resource, grantKind, scopes }) => `${clientId} ${resource === null ? "login" : "toolbox"} ${grantKind} ${(scopes as string[]).join(" ")}`),
  entitlements: hub.id.entitlements(hub.organisation).map(({ clientId, resource, scopes, memberId, groupId }) => `${clientId} ${resource === null ? "login" : "toolbox"} ${(scopes as string[]).join(" ")} ${memberId ?? groupId ?? "organisation"}`),
})
const created = (host: string) => [
  `link ${host}`,
  `capability ${host} login authorization_code`, `capability ${host} login refresh_token`, `capability ${host} toolbox authorization_code`, `capability ${host} toolbox refresh_token`,
  `entitlement ${host} login`, `entitlement ${host} toolbox`,
]

test("enabling one organisation for one host client and one provider makes the ID calls in order, and leaves the pair rows, the allowed scopes and the catalogue row", async () => {
  const hub = await setup({ scopes: ["offline_access", "toolbox", "legacy:scope"] })
  const [provider] = hub.mounted
  const answer = await hub.enable({ hostClientIds: ["host-a"], providers: [provider!.id] })
  expect(answer).toMatchObject({ status: 200, body: { organisation_id: hub.organisation, existing: [] } })
  expect(answer.body.created).toEqual([`allowed scopes of ${resource}`, ...created("host-a"), `catalogue ${provider!.id}`])
  const org = `/organizations/${hub.organisation}`
  expect(hub.calls()).toEqual([
    `GET /resources/${path}`, `GET ${org}/capabilities?limit=200`, `GET ${org}/entitlements?clientId=host-a&limit=200`,
    `PATCH /resources/${path}`, `PUT /clients/host-a/resources/${path}`, ...Array(4).fill(`POST ${org}/capabilities`), ...Array(2).fill(`POST ${org}/entitlements`),
  ])
  // The union keeps what was there, and adds the Toolbox's own scopes and the provider's grant strings, in ID's order.
  expect(hub.id.resourceOf(resource).allowedScopes).toEqual([...new Set(["legacy:scope", ...allowedScopes([provider!])])].sort())
  expect(hub.id.resourceOf(resource).clients).toEqual(["host-a"])
  expect(rows(hub)).toEqual({
    capabilities: ["host-a login authorization_code openid offline_access", "host-a login refresh_token openid offline_access", "host-a toolbox authorization_code toolbox", "host-a toolbox refresh_token toolbox"],
    entitlements: ["host-a login openid offline_access organisation", "host-a toolbox toolbox organisation"],
  })
  expect(await readCatalogue(db, hub.organisation)).toEqual(new Map([[provider!.id, { enabled: true, overrides: { disabled: [], policy_class: {} } }]]))
  expect(hub.id.scopesAsked).toEqual(["platform:read platform:write"])
})

test("two host clients and two providers make each call once; a host client added later gets only its own rows", async () => {
  const hub = await setup({ providers: 2, hosts: ["host-a", "host-b"] })
  const [one, two] = hub.mounted
  const answer = await hub.enable({ hostClientIds: ["host-a", "host-b", "host-a"], providers: [one!.id, two!.id, one!.id] })
  expect(answer.body.created).toEqual([`allowed scopes of ${resource}`, ...created("host-a"), ...created("host-b"), `catalogue ${one!.id}`, `catalogue ${two!.id}`])
  const writes = hub.calls().filter(call => !call.startsWith("GET"))
  expect(writes).toHaveLength(1 + 2 * 7)
  expect(hub.calls().filter(call => call.startsWith("GET"))).toHaveLength(4)
  expect(hub.id.resourceOf(resource).allowedScopes).toEqual(allowedScopes([one!, two!]))
  const later = await setup({ hosts: ["host-a", "host-c"] })
  await later.enable({ hostClientIds: ["host-a"], providers: [later.mounted[0]!.id] })
  const answerLater = await later.enable({ hostClientIds: ["host-a", "host-c"], providers: [later.mounted[0]!.id] })
  expect(answerLater.body.created).toEqual(created("host-c"))
  expect(answerLater.body.existing).toEqual([`allowed scopes of ${resource}`, ...created("host-a"), `catalogue ${later.mounted[0]!.id}`])
})

test("a failure part way answers 502 saying what ID answered, and repeating the call creates only what is missing, each row once", async () => {
  const hub = await setup()
  const provider = hub.mounted[0]!.id
  const body = { hostClientIds: ["host-a"], providers: [provider] }
  hub.id.failWrite(4)
  const failed = await hub.enable(body)
  expect(failed.status).toBe(502)
  expect(failed.body.error.code).toBe("id_failed")
  expect(failed.body.error.message).toBe(
    `Answerable ID answered POST ${api}/organizations/${hub.organisation}/capabilities with 503 database_busy: Database is busy. Nothing is rolled back: repeat the call, which skips what already exists`,
  )
  expect(hub.id.capabilities(hub.organisation)).toHaveLength(1)
  expect((await readCatalogue(db, hub.organisation)).size).toBe(0)
  const repeated = await hub.enable(body)
  expect(repeated.status).toBe(200)
  expect(repeated.body.existing).toEqual([`allowed scopes of ${resource}`, "link host-a", "capability host-a login authorization_code"])
  expect(repeated.body.created).toEqual(["capability host-a login refresh_token", "capability host-a toolbox authorization_code", "capability host-a toolbox refresh_token", "entitlement host-a login", "entitlement host-a toolbox", `catalogue ${provider}`])
  expect(rows(hub).capabilities).toHaveLength(4)
  expect(rows(hub).entitlements).toHaveLength(2)
})

test("rows ID already holds count when active with the scopes needed, and stop the call, before anything is written, when they do not fit", async () => {
  const hub = await setup()
  const body = { hostClientIds: ["host-a"], providers: [hub.mounted[0]!.id] }
  const row = (fields: Record<string, unknown>) => ({ id: Bun.randomUUIDv7(), organizationId: hub.organisation, memberId: null, groupId: null, clientId: "host-a", resource: null, status: "active", ...fields })
  const fitting = row({ grantKind: "authorization_code", scopes: ["openid", "offline_access", "profile"] })
  hub.id.capabilities(hub.organisation).push(fitting as never)
  const short = row({ grantKind: "refresh_token", scopes: ["openid"] })
  hub.id.capabilities(hub.organisation).push(short as never)
  const conflict = await hub.enable(body)
  expect(conflict.status).toBe(409)
  expect(conflict.body.error).toEqual({
    code: "id_row_conflict",
    message: `Answerable ID already holds the login refresh_token capability of host-a (${short.id}) with status active and scopes openid; give it at least openid offline_access in ID, then repeat the call`,
  })
  expect(hub.calls().filter(call => !call.startsWith("GET"))).toEqual([])
  hub.id.capabilities(hub.organisation).splice(1, 1, row({ grantKind: "refresh_token", scopes: ["openid", "offline_access"], status: "disabled" }) as never)
  const disabled = await hub.enable(body)
  expect(disabled.body.error.message).toContain("with status disabled and scopes openid offline_access; make it active")
  hub.id.capabilities(hub.organisation).splice(1, 1, row({ grantKind: "refresh_token", scopes: ["offline_access", "openid"] }) as never)
  hub.id.entitlements(hub.organisation).push(row({ resource: null, scopes: ["openid"] }) as never)
  const entitlement = await hub.enable(body)
  expect(entitlement.status).toBe(409)
  expect(entitlement.body.error.message).toMatch(/^Answerable ID already holds the login entitlement of host-a \(.+\) with status active and scopes openid;/)
  hub.id.entitlements(hub.organisation).splice(0, 1, row({ resource: null, scopes: ["openid", "offline_access"] }) as never)
  const answer = await hub.enable(body)
  expect(answer.status).toBe(200)
  expect(answer.body.existing).toEqual(["capability host-a login authorization_code", "capability host-a login refresh_token", "entitlement host-a login"])
  expect(answer.body.created).toContain("capability host-a toolbox refresh_token")
  expect(rows(hub).capabilities).toHaveLength(4)
})

test("every page of the organisation's capabilities and of the client's entitlements is read", async () => {
  const hub = await setup({ pageSize: 2 })
  const row = (fields: Record<string, unknown>) => ({ id: Bun.randomUUIDv7(), organizationId: hub.organisation, memberId: null, groupId: null, clientId: "host-a", resource: null, status: "active", ...fields }) as never
  for (const client of ["other-1", "other-2", "other-3", "other-4"]) hub.id.capabilities(hub.organisation).push(row({ clientId: client, grantKind: "authorization_code", scopes: ["openid", "offline_access"] }))
  hub.id.capabilities(hub.organisation).push(row({ grantKind: "authorization_code", scopes: ["openid", "offline_access"] }))
  for (let member = 0; member < 3; member++) hub.id.entitlements(hub.organisation).push(row({ memberId: crypto.randomUUID(), scopes: ["e2e"] }))
  hub.id.entitlements(hub.organisation).push(row({ scopes: ["openid", "offline_access"] }))
  const answer = await hub.enable({ hostClientIds: ["host-a"], providers: [hub.mounted[0]!.id] })
  expect(answer.body.existing).toEqual(["capability host-a login authorization_code", "entitlement host-a login"])
  expect(answer.body.created).toHaveLength(1 + 7 + 1 - 2)
  const gets = hub.calls().filter(call => call.startsWith("GET /organizations"))
  expect(gets.filter(call => call.includes("/capabilities?"))).toHaveLength(3)
  expect(gets.filter(call => call.includes("/entitlements?"))).toHaveLength(2)
  expect(gets.filter(call => call.includes("cursor="))).toHaveLength(3)
})

test("an entitlement of a member or a group to the same client is not the organisation's pair row", async () => {
  const hub = await setup()
  const member = { id: Bun.randomUUIDv7(), organizationId: hub.organisation, memberId: crypto.randomUUID(), groupId: null, clientId: "host-a", resource: null, status: "active", scopes: ["openid", "offline_access"] }
  hub.id.entitlements(hub.organisation).push(member as never)
  expect((await hub.enable({ hostClientIds: ["host-a"], providers: [hub.mounted[0]!.id] })).body.created).toContain("entitlement host-a login")
})

test("an existing catalogue row keeps its overrides and is enabled; one already enabled is left alone", async () => {
  const hub = await setup()
  const provider = hub.mounted[0]!.id
  const overrides = { disabled: [`${provider}/records.list`], policy_class: { [`${provider}/records.create`]: "human" as const } }
  await writeCatalogue(db, hub.organisation, provider, { enabled: false, overrides })
  const body = { hostClientIds: ["host-a"], providers: [provider] }
  expect((await hub.enable(body)).body.created).toContain(`catalogue ${provider}`)
  expect(await readCatalogue(db, hub.organisation)).toEqual(new Map([[provider, { enabled: true, overrides }]]))
  expect((await hub.enable(body)).body.created).toEqual([])
  expect((await readCatalogue(db, hub.organisation)).get(provider)!.overrides).toEqual(overrides)
})

test("a body that is not an enable request, or names a provider that is not mounted, is refused before ID is asked anything", async () => {
  const hub = await setup()
  for (const body of [{}, { hostClientIds: ["host-a"] }, { hostClientIds: [], providers: [hub.mounted[0]!.id] }, { hostClientIds: ["host-a"], providers: [] }, { hostClientIds: "host-a", providers: [hub.mounted[0]!.id] }, { hostClientIds: ["host-a"], providers: [hub.mounted[0]!.id], all: true }]) {
    expect(await hub.enable(body), JSON.stringify(body)).toMatchObject({ status: 400, body: { error: { code: "invalid_request" } } })
  }
  expect(await hub.enable({ hostClientIds: ["host-a"], providers: [hub.mounted[0]!.id, "nothing", "toolbox"] })).toMatchObject({
    status: 422, body: { error: { code: "unknown_provider", message: `nothing, toolbox are not mounted in this Toolbox; mounted: ${hub.mounted[0]!.id}` } },
  })
  expect(await hub.admin("POST", "/organisations/not-a-uuid/enable", { body: { hostClientIds: ["host-a"], providers: [hub.mounted[0]!.id] } })).toMatchObject({ status: 400, body: { error: { code: "invalid_request" } } })
  expect(hub.id.requests).toEqual([])
})

test("what ID lacks is named: the Toolbox resource, the organisation and the host client", async () => {
  const hub = await setup({ hosts: ["host-a"] })
  const body = { hostClientIds: ["host-a"], providers: [hub.mounted[0]!.id] }
  const unregistered = await createHub(db, hub.mounted)
  unregistered.id.organisation(hub.organisation)
  expect(await unregistered.admin("POST", `/organisations/${hub.organisation}/enable`, { body })).toMatchObject({
    status: 409, body: { error: { code: "resource_not_registered", message: `Answerable ID does not know the resource ${resource}; register it first, as the Toolbox administration page shows` } },
  })
  const stranger = crypto.randomUUID()
  expect(await hub.admin("POST", `/organisations/${stranger}/enable`, { body })).toMatchObject({
    status: 404, body: { error: { code: "organisation_not_found", message: `Answerable ID does not know the organisation ${stranger}; GET /api/admin/v1/organizations lists the ones it does` } },
  })
  expect(hub.calls().filter(call => !call.startsWith("GET"))).toEqual([])
  expect(await hub.enable({ ...body, hostClientIds: ["host-a", "host-z"] })).toMatchObject({
    status: 422, body: { error: { code: "unknown_host_client", message: "Answerable ID has no client host-z; register it first" } },
  })
})

test("when ID cannot be reached, refuses the Toolbox's credentials or times out, the answer is 502 and says which", async () => {
  const body = (hub: Awaited<ReturnType<typeof setup>>) => ({ hostClientIds: ["host-a"], providers: [hub.mounted[0]!.id] })
  const down = await setup()
  down.id.outage(true)
  expect((await down.enable(body(down))).body.error).toEqual({
    code: "id_failed",
    message: "Answerable ID refused the client credentials of toolbox-hub (503); check the client id, the client secret and the client's platform:read and platform:write capability for the admin resource. Nothing is rolled back: repeat the call, which skips what already exists",
  })
  const wrong = await setup()
  const strangers = await createHub(db, wrong.mounted, { secret: "wrong" })
  expect((await strangers.admin("POST", `/organisations/${wrong.organisation}/enable`, { body: body(wrong) })).body.error.message).toContain("refused the client credentials of toolbox-hub (401)")
  const gone = await setup()
  gone.id.unreachable(true)
  expect((await gone.enable(body(gone))).body.error.message).toBe("Answerable ID did not answer the token request: Unable to connect. Nothing is rolled back: repeat the call, which skips what already exists")
  const slow = await setup()
  await slow.enable(body(slow))
  slow.id.unreachable(true)
  expect((await slow.enable(body(slow))).body.error.message).toBe(`Answerable ID did not answer GET ${api}/resources/${path}: Unable to connect. Nothing is rolled back: repeat the call, which skips what already exists`)
})
