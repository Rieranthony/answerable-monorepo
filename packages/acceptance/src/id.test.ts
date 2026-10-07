import { afterAll, afterEach, expect, spyOn, test } from "bun:test"
import { existsSync } from "node:fs"
import { dirname } from "node:path"
import { startId } from "./id"

const origin = { idOrigin: "http://127.0.0.1:47600", adminResource: "http://127.0.0.1:47600/api/admin", rootSecret: "root-secret" }
/** A company directory as the fixture writes it, at a local issuer on `port`. */
function directory(slug: string, person: string, port: number) {
  const issuer = `http://127.0.0.1:${port}`
  const endpoints = { authorizationEndpoint: `${issuer}/authorize`, tokenEndpoint: `${issuer}/token`, jwksEndpoint: `${issuer}/jwks` }
  return { slug, domain: `${slug}.example.test`, email: `${person}@${slug}.example.test`, issuer, ...endpoints, clientId: slug, clientSecret: "local-fixture-only" }
}
const acme = directory("acme", "tester", 50_001)
const staff = directory("answerable", "staff", 50_002)
const spare = directory("spare", "tester", 50_003)
const platformOrganizationId = crypto.randomUUID()
const organizationId = crypto.randomUUID()
const tenants = [{ slug: "acme", signIns: 2 }]
const log = spyOn(console, "log").mockImplementation(() => {})
afterAll(() => log.mockRestore())

let spawned: { mockRestore(): void } | undefined
let fetched: { mockRestore(): void } | undefined
afterEach(() => (spawned?.mockRestore(), fetched?.mockRestore()))

/** `Bun.spawn` replaced: Compose commands succeed, and the fixture writes `written` as its manifest and runs until it is killed. */
function fakeSpawn(written: object) {
  const commands: string[][] = []
  const signals: string[] = []
  const spawn = (command: string[]) => {
    commands.push(command)
    if (command[0] === "docker") return { exitCode: null, exited: Promise.resolve(0), kill() {} }
    void Bun.write(command[3]!, JSON.stringify(written))
    let stop: (code: number) => void = () => {}
    const exited = new Promise<number>(resolve => (stop = resolve))
    return { exitCode: null, exited, kill: (signal: string) => (signals.push(signal), stop(137)) }
  }
  spawned = spyOn(Bun, "spawn").mockImplementation(spawn as never)
  return { commands, signals, directory: () => dirname(commands.find(command => command[0] !== "docker")![2]!) }
}

/** `fetch` replaced by ID's admin API, which records each call as root and answers a new organisation with `organizationId`. */
function fakeAdminApi() {
  const calls: unknown[][] = []
  const answer = async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers)
    const path = new URL(url).pathname.replace("/api/admin/v1", "")
    calls.push([init.method, path, JSON.parse(String(init.body)), headers.get("If-None-Match"), headers.get("Authorization")])
    return Response.json(path === "/organizations" ? { id: organizationId } : {}, { status: 201 })
  }
  fetched = spyOn(globalThis, "fetch").mockImplementation(answer as never)
  return calls
}

/** What `setSsoProvider` sends for `company`'s directory. */
const sso = (company: ReturnType<typeof directory>) => ({
  issuer: company.issuer,
  domain: company.domain,
  oidc: { credentials: "own", clientId: company.clientId, clientSecret: company.clientSecret, authorizationEndpoint: company.authorizationEndpoint, tokenEndpoint: company.tokenEndpoint, jwksEndpoint: company.jwksEndpoint },
})

test("startId runs Compose, hands the fixture its plan, creates each tenant's organisation, domain and single sign-on, returns the manifest and an admin, and stop() undoes it all", async () => {
  const fake = fakeSpawn({ ...origin, platformOrganizationId, tenants: [acme], spares: [] })
  const calls = fakeAdminApi()
  const id = await startId({ tenants })
  expect(fake.commands[0]!.slice(0, 4)).toEqual(["docker", "compose", "-p", "answerable-mcp-e2e"])
  expect(fake.commands[0]!.slice(-3)).toEqual(["up", "-d", "--wait"])
  expect(fake.commands[1]!.slice(1)).toEqual([expect.stringMatching(/mcp-e2e-fixture\.ts$/), expect.stringMatching(/plan\.json$/), expect.stringMatching(/manifest\.json$/), "--isolated-mcp-fixture"])
  expect(await Bun.file(fake.commands[1]![2]!).json()).toEqual({ tenants })
  const root = "Bearer root-secret"
  expect(calls).toEqual([
    ["POST", "/organizations", { slug: "acme", name: "acme" }, null, root],
    ["POST", `/organizations/${organizationId}/domains`, { domain: "acme.example.test" }, null, root],
    ["PUT", `/organizations/${organizationId}/sso-provider`, sso(acme), "*", root],
  ])
  expect(id.manifest).toEqual({ ...origin, tenants: [{ slug: "acme", email: "tester@acme.example.test", organizationId }], spares: [] })
  expect(id.admin).toBeFunction()
  await id.stop()
  await id.stop()
  expect(fake.signals).toEqual(["SIGKILL"])
  expect(fake.commands.filter(command => command.includes("down") && command.includes("--volumes"))).toHaveLength(1)
  expect(existsSync(fake.directory())).toBe(false)
})

test("the platform and spare plan fields reach the fixture, the platform organisation gets its domain and single sign-on, and the spares come back as written", async () => {
  const fake = fakeSpawn({ ...origin, platformOrganizationId, tenants: [], platform: staff, spares: [spare] })
  const calls = fakeAdminApi()
  const id = await startId({ tenants: [], platform: { signIns: 1 }, spares: [{ slug: "spare", signIns: 2 }] })
  expect(await Bun.file(fake.commands[1]![2]!).json()).toEqual({ tenants: [], platform: { signIns: 1 }, spares: [{ slug: "spare", signIns: 2 }] })
  expect(calls.map(([method, path, body]) => [method, path, body])).toEqual([
    ["POST", `/organizations/${platformOrganizationId}/domains`, { domain: "answerable.example.test" }],
    ["PUT", `/organizations/${platformOrganizationId}/sso-provider`, sso(staff)],
  ])
  expect(id.manifest).toEqual({ ...origin, tenants: [], platform: { organizationId: platformOrganizationId, domain: "answerable.example.test", email: "staff@answerable.example.test" }, spares: [spare] })
  await id.stop()
})
